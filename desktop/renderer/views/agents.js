window.Views = window.Views || {};
window.Views.agents = (function () {
  async function render(root, ctx) {
    const [health, status] = await Promise.all([
      ctx.api.getAgentHealth(ctx.project),
      ctx.api.getStatus(),
    ]);
    const currentAgent = status?.mission?.currentAgent ?? null;

    if (!health.length) {
      root.innerHTML = `
        <div class="section">
          <div class="section-title">Agents — ${OViz.escapeHtml(ctx.project || '')}</div>
          ${OViz.empty('No agents configured. Add config/agents.json (copy config/agents.example.json) to define specialized agents. Without it, every project runs on a single implicit agent wrapping its driver.')}
        </div>`;
      return;
    }

    const cards = health.map((a) => {
      const isCurrent = a.agentId === currentAgent;
      const install = a.installed === null
        ? '<span class="badge idle">unchecked</span>'
        : (a.installed
          ? `<span class="badge done">installed</span>`
          : `<span class="badge failed">missing</span>`);
      return `
        <div class="card" style="${isCurrent ? 'border-color:var(--accent)' : ''}">
          <div class="row between">
            <div class="value" style="font-size:15px">${OViz.escapeHtml(a.agentId)}${isCurrent ? ' <span class="badge active">current</span>' : ''}</div>
            <span class="role-badge role-${OViz.escapeHtml(a.role)}">${OViz.escapeHtml(a.role)}</span>
          </div>
          <div class="sub" style="margin-top:6px">driver <span class="mono">${OViz.escapeHtml(a.driver)}</span> · ${install}
            ${a.version ? `<span class="mono" style="color:var(--text-dim)">${OViz.escapeHtml(a.version)}</span>` : ''}
            ${a.installError ? `<span style="color:var(--red)">${OViz.escapeHtml(a.installError)}</span>` : ''}
          </div>
          ${a.capabilities?.length ? `<div class="sub">capabilities: ${a.capabilities.map((c) => OViz.escapeHtml(c)).join(', ')}</div>` : ''}
          <div class="row" style="margin-top:10px; gap:18px">
            <div><div class="value" style="font-size:18px;color:var(--green)">${a.tasksDone}</div><div class="sub">done</div></div>
            <div><div class="value" style="font-size:18px;color:var(--red)">${a.tasksFailed}</div><div class="sub">failed</div></div>
            <div><div class="value" style="font-size:18px;color:var(--red)">${a.tasksBlocked}</div><div class="sub">blocked</div></div>
            <div><div class="value" style="font-size:18px">${a.totalAttempts}</div><div class="sub">attempts</div></div>
          </div>
          ${a.lastUsedAt ? `<div class="sub" style="margin-top:8px">last used ${OViz.fmtDate(a.lastUsedAt)}</div>` : ''}
        </div>`;
    }).join('');

    root.innerHTML = `
      <div class="section">
        <div class="row between">
          <div class="section-title">Agents — ${OViz.escapeHtml(ctx.project || '')}</div>
          <button class="btn small" id="refresh">Refresh</button>
        </div>
        <div class="sub" style="margin-bottom:12px">Specialized agents are routed per task by the task's agent id, role, or capabilities. Tasks with no routing hint run on the default agent.</div>
        <div class="grid">${cards}</div>
      </div>`;

    root.querySelector('#refresh')?.addEventListener('click', () => render(root, ctx));
  }

  return { mount: render, tick: render };
})();
