window.Views = window.Views || {};
window.Views.memory = (function () {
  async function render(root, ctx) {
    if (!ctx.project) {
      root.innerHTML = OViz.empty('Select a project first.');
      return;
    }
    const mem = await ctx.api.getMemory(ctx.project);
    const notes = mem?.notes ?? [];
    const failures = mem?.failures ?? [];
    const history = mem?.taskHistory ?? [];

    root.innerHTML = `
      <div class="section">
        <div class="row between"><div class="section-title">Operator notes</div><button class="btn small" id="refresh">Refresh</button></div>
        ${notes.length ? `<table><thead><tr><th>#</th><th>Category</th><th>Note</th><th>When</th></tr></thead><tbody>
          ${notes.slice().reverse().map((n) => `<tr><td>${n.id}</td><td>${OViz.escapeHtml(n.category)}</td><td>${OViz.escapeHtml(n.text)}</td><td>${OViz.fmtDate(n.at)}</td></tr>`).join('')}
        </tbody></table>` : OViz.empty('No notes recorded yet.')}
        <div class="card" style="margin-top:12px">
          <form class="form" id="note-form">
            <label>Category
              <select name="category"><option value="project">project</option><option value="architecture">architecture</option></select>
            </label>
            <label>Note <input name="text" required placeholder="always run npm run build first" /></label>
            <div class="row"><button type="submit" class="btn primary">Add note</button></div>
          </form>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Failure history</div>
        ${failures.length ? `<table><thead><tr><th>#</th><th>Status</th><th>Scope</th><th>Reason</th><th></th></tr></thead><tbody>
          ${failures.slice().reverse().map((f) => `
            <tr data-failure="${f.id}">
              <td>${f.id}</td>
              <td>${f.resolved ? OViz.badge('done') : OViz.badge('failed')}</td>
              <td>${f.taskId ? `task ${OViz.escapeHtml(f.taskId)}` : 'mission'}</td>
              <td>${OViz.escapeHtml(f.reason)}</td>
              <td>${!f.resolved ? '<button class="btn small" data-action="resolve">Mark resolved</button>' : ''}</td>
            </tr>`).join('')}
        </tbody></table>` : OViz.empty('No failures recorded yet.')}
      </div>

      <div class="section">
        <div class="section-title">Archived task history</div>
        ${history.length ? `<table><thead><tr><th>Task</th><th>Outcome</th><th>Attempts</th><th>When</th></tr></thead><tbody>
          ${history.slice().reverse().map((h) => `<tr><td>${OViz.escapeHtml(h.taskId)}</td><td>${OViz.badge(h.outcome)}</td><td>${h.attempts}</td><td>${OViz.fmtDate(h.at)}</td></tr>`).join('')}
        </tbody></table>` : OViz.empty('Nothing archived yet.')}
      </div>
    `;

    root.querySelector('#refresh')?.addEventListener('click', () => render(root, ctx));

    root.querySelectorAll('[data-failure]').forEach((tr) => {
      tr.querySelector('[data-action="resolve"]')?.addEventListener('click', async () => {
        const r = await ctx.api.resolveFailure(ctx.project, tr.dataset.failure);
        ctx.toast(r.ok ? 'Marked resolved.' : r.reason, r.ok ? 'success' : 'error');
        render(root, ctx);
      });
    });

    root.querySelector('#note-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const r = await ctx.api.addNote(ctx.project, { category: form.get('category'), text: form.get('text') });
      ctx.toast(r.ok ? 'Note added.' : r.reason, r.ok ? 'success' : 'error');
      render(root, ctx);
    });
  }

  return { mount: render };
})();
