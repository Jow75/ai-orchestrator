window.Views = window.Views || {};
// Phase 10A: the Approvals view — every pending request across projects,
// decidable in one click (APPROVE / REJECT / MODIFY / DONE). A mission
// paused on a request picks the decision up within its poll interval.
window.Views.approvals = (function () {
  const STATUS_BADGE = {
    pending: 'active', approved: 'done', 'auto-approved': 'done', done: 'done',
    modified: 'done', rejected: 'failed', expired: 'failed', cancelled: 'idle',
  };

  async function render(root, ctx) {
    const [pending, projectHistory] = await Promise.all([
      ctx.api.getApprovals(),
      ctx.project ? ctx.api.getApprovals(ctx.project) : Promise.resolve([]),
    ]);

    const pendingCards = pending.map((r) => card(r, true)).join('');
    const decided = projectHistory.filter((r) => r.status !== 'pending').slice(-15).reverse();
    const historyRows = decided.map((r) => `
      <tr>
        <td class="mono">${OViz.escapeHtml(r.id)}</td>
        <td><span class="badge ${STATUS_BADGE[r.status] ?? 'idle'}">${OViz.escapeHtml(r.status)}</span></td>
        <td>${OViz.escapeHtml(r.category)}</td>
        <td class="sub">${OViz.fmtDate(r.decidedAt ?? r.createdAt)}${r.via ? ` via ${OViz.escapeHtml(r.via)}` : ''}</td>
      </tr>`).join('');

    root.innerHTML = `
      <div class="section">
        <div class="row between">
          <div class="section-title">Pending approvals — all projects</div>
          <button class="btn small" id="refresh">Refresh</button>
        </div>
        ${pending.length ? `<div class="grid">${pendingCards}</div>`
          : OViz.empty('Nothing awaits your decision. Missions pause here when the Approval Manager needs you (implementation reviews, owner gates, human actions).')}
      </div>
      <div class="section">
        <div class="section-title">Recent decisions — ${OViz.escapeHtml(ctx.project || '(select a project)')}</div>
        ${decided.length
          ? `<table class="table"><thead><tr><th>id</th><th>status</th><th>category</th><th>decided</th></tr></thead><tbody>${historyRows}</tbody></table>`
          : OViz.empty('No decided requests recorded for this project yet.')}
      </div>`;

    root.querySelector('#refresh')?.addEventListener('click', () => render(root, ctx));
    root.querySelectorAll('[data-decide]').forEach((button) => {
      button.addEventListener('click', async () => {
        const { decide, project, id } = button.dataset;
        let note;
        if (decide === 'modified') {
          note = window.prompt(`Modification note for ${id} (what should change):`);
          if (!note) return;
        }
        if (decide === 'rejected') {
          note = window.prompt(`Optional reason for rejecting ${id}:`) || undefined;
        }
        const result = await ctx.api.decideApproval(project, id, decide, note);
        ctx.toast(result.ok ? `${id} ${decide}.` : `Failed: ${result.reason}`, result.ok ? 'success' : 'error');
        render(root, ctx);
      });
    });
  }

  function card(r, showActions) {
    const isHumanAction = r.approvalClass === 'human-action';
    const actions = isHumanAction
      ? `<button class="btn primary small" data-decide="done" data-project="${OViz.escapeHtml(r.project)}" data-id="${OViz.escapeHtml(r.id)}">Done — I did it</button>`
      : `
        <button class="btn primary small" data-decide="approved" data-project="${OViz.escapeHtml(r.project)}" data-id="${OViz.escapeHtml(r.id)}">Approve</button>
        <button class="btn small" data-decide="modified" data-project="${OViz.escapeHtml(r.project)}" data-id="${OViz.escapeHtml(r.id)}">Modify…</button>
        <button class="btn danger small" data-decide="rejected" data-project="${OViz.escapeHtml(r.project)}" data-id="${OViz.escapeHtml(r.id)}">Reject</button>`;
    return `
      <div class="card">
        <div class="row between">
          <div class="value" style="font-size:15px"><span class="mono">${OViz.escapeHtml(r.id)}</span> · ${OViz.escapeHtml(r.project)}</div>
          <span class="badge active">${OViz.escapeHtml(r.approvalClass)}</span>
        </div>
        <div class="sub" style="margin-top:6px">${OViz.escapeHtml(r.title)}</div>
        ${r.summary ? `<pre class="mono" style="white-space:pre-wrap;font-size:12px;color:var(--text-dim);margin:8px 0;max-height:180px;overflow:auto">${OViz.escapeHtml(r.summary)}</pre>` : ''}
        <div class="sub">category ${OViz.escapeHtml(r.category)}${r.taskId ? ` · task ${OViz.escapeHtml(r.taskId)}` : ''} · since ${OViz.fmtDate(r.createdAt)}</div>
        ${showActions ? `<div class="row" style="margin-top:10px">${actions}</div>` : ''}
      </div>`;
  }

  return { mount: render, tick: render };
})();
