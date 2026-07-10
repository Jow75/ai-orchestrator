window.Views = window.Views || {};
window.Views.tasks = (function () {
  async function render(root, ctx) {
    if (!ctx.project) {
      root.innerHTML = OViz.empty('Select a project first.');
      return;
    }
    const [queue, agents] = await Promise.all([
      ctx.api.getTasks(ctx.project),
      ctx.api.getAgents(ctx.project),
    ]);
    const tasks = queue?.tasks ?? [];
    const currentIndex = queue?.currentIndex ?? -1;
    const ROLES = ['', 'planner', 'coding', 'testing', 'documentation', 'research', 'review'];

    const rows = tasks.map((t, i) => {
      const isCurrent = i === currentIndex;
      const pendingIndexes = tasks.map((x, idx) => (x.state === 'pending' ? idx : -1)).filter((x) => x >= 0);
      const posInPending = pendingIndexes.indexOf(i);
      const canReorderUp = t.state === 'pending' && posInPending > 0;
      const canReorderDown = t.state === 'pending' && posInPending >= 0 && posInPending < pendingIndexes.length - 1;
      const canRemove = t.state === 'pending';
      const canApproveOrSkip = isCurrent && (t.state === 'blocked' || t.state === 'failed');

      const route = t.checkpoint?.agentId ?? t.assignedAgentId ?? t.agent ?? (t.role ? `role: ${t.role}` : '—');
      return `
        <tr data-task="${OViz.escapeHtml(t.id)}">
          <td>${isCurrent ? '→ ' : ''}${OViz.escapeHtml(t.id)}</td>
          <td>${OViz.badge(t.state)}</td>
          <td>${t.attempts}</td>
          <td>${OViz.escapeHtml(route)}</td>
          <td>${OViz.escapeHtml(t.objective ?? '')}</td>
          <td>${OViz.escapeHtml((t.checkpoint?.summary ?? '').split('\n')[0].slice(0, 80))}</td>
          <td class="row">
            ${canReorderUp ? '<button class="btn small" data-action="up">↑</button>' : ''}
            ${canReorderDown ? '<button class="btn small" data-action="down">↓</button>' : ''}
            ${canRemove ? '<button class="btn small danger" data-action="remove">Remove</button>' : ''}
            ${canApproveOrSkip ? '<button class="btn small primary" data-action="approve">Approve retry</button>' : ''}
            ${canApproveOrSkip ? '<button class="btn small" data-action="skip">Skip</button>' : ''}
          </td>
        </tr>`;
    }).join('');

    root.innerHTML = `
      <div class="section">
        <div class="row between"><div class="section-title">Task queue — ${OViz.escapeHtml(ctx.project)}</div><button class="btn small" id="refresh">Refresh</button></div>
        ${tasks.length ? `
          <table>
            <thead><tr><th>ID</th><th>State</th><th>Attempts</th><th>Agent / role</th><th>Objective</th><th>Last summary</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>` : OViz.empty('No tasks queued yet for this project.')}
      </div>

      <div class="section">
        <div class="section-title">Add a task</div>
        <div class="card">
          <form class="form" id="add-form">
            <label>Task ID <input name="id" required placeholder="T3" /></label>
            <label>Prompt file (relative to the project's working directory, or absolute) <input name="prompt" required placeholder="tasks/03-cleanup.md" /></label>
            <label>Objective (optional) <input name="objective" placeholder="Human-readable description" /></label>
            <label>Role (optional — routes to an agent filling this role)
              <select name="role">${ROLES.map((r) => `<option value="${r}">${r || '(default agent)'}</option>`).join('')}</select>
            </label>
            <label>Agent (optional — an explicit agent id, overrides role)
              <select name="agent">
                <option value="">(auto by role)</option>
                ${(agents ?? []).map((a) => `<option value="${OViz.escapeHtml(a.id ?? a.agentId)}">${OViz.escapeHtml(a.id ?? a.agentId)}</option>`).join('')}
              </select>
            </label>
            <label>Max runs (optional) <input name="maxRuns" type="number" min="1" placeholder="5" /></label>
            <label>Verify rules (optional — raw JSON array, e.g. tasks add --verify-file)
              <textarea name="verify" placeholder='[{"type":"file-exists","path":"out.txt"}]'></textarea>
            </label>
            <div class="row"><button type="submit" class="btn primary">Add task</button></div>
          </form>
        </div>
      </div>
    `;

    root.querySelector('#refresh')?.addEventListener('click', () => render(root, ctx));

    root.querySelectorAll('tr[data-task]').forEach((tr) => {
      const taskId = tr.dataset.task;
      tr.querySelector('[data-action="up"]')?.addEventListener('click', async () => {
        const r = await ctx.api.reorderTask(ctx.project, taskId, 'up');
        if (!r.ok) ctx.toast(r.reason, 'error');
        render(root, ctx);
      });
      tr.querySelector('[data-action="down"]')?.addEventListener('click', async () => {
        const r = await ctx.api.reorderTask(ctx.project, taskId, 'down');
        if (!r.ok) ctx.toast(r.reason, 'error');
        render(root, ctx);
      });
      tr.querySelector('[data-action="remove"]')?.addEventListener('click', async () => {
        const r = await ctx.api.removeTask(ctx.project, taskId);
        if (!r.ok) ctx.toast(r.reason, 'error');
        render(root, ctx);
      });
      tr.querySelector('[data-action="approve"]')?.addEventListener('click', async () => {
        const r = await ctx.api.approveTask(ctx.project, taskId);
        ctx.toast(r.ok ? `Task "${taskId}" approved for retry.` : r.reason, r.ok ? 'success' : 'error');
        render(root, ctx);
      });
      tr.querySelector('[data-action="skip"]')?.addEventListener('click', async () => {
        const reason = prompt('Why is this task being skipped? (optional)') ?? undefined;
        const r = await ctx.api.skipTask(ctx.project, taskId, reason);
        ctx.toast(r.ok ? `Task "${taskId}" skipped.` : r.reason, r.ok ? 'success' : 'error');
        render(root, ctx);
      });
    });

    root.querySelector('#add-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      let verify = [];
      const rawVerify = form.get('verify')?.trim();
      if (rawVerify) {
        try {
          verify = JSON.parse(rawVerify);
        } catch (error) {
          ctx.toast(`Verify rules are not valid JSON: ${error.message}`, 'error');
          return;
        }
      }
      const maxRuns = form.get('maxRuns') ? Number(form.get('maxRuns')) : undefined;
      const result = await ctx.api.addTask(ctx.project, {
        id: form.get('id'), prompt: form.get('prompt'), objective: form.get('objective') || undefined, maxRuns, verify,
        role: form.get('role') || undefined,
        agent: form.get('agent') || undefined,
      });
      if (result.ok) {
        ctx.toast(`Task "${form.get('id')}" queued.`, 'success');
        render(root, ctx);
      } else {
        ctx.toast(`Could not add task: ${(result.problems ?? [result.reason]).join('; ')}`, 'error');
      }
    });
  }

  return { mount: render };
})();
