window.Views = window.Views || {};
window.Views.dashboard = (function () {
  function html(status, projects, selectedProject) {
    const o = status?.orchestrator ?? {};
    const session = status?.session;
    const agent = status?.agent;
    const activity = status?.activity ?? {};
    const counters = status?.counters ?? {};
    const rateLimit = status?.rateLimit ?? {};
    const mission = status?.mission;

    const cards = !status ? OViz.empty('No status yet — start a mission from the Missions tab.') : `
      <div class="grid">
        <div class="card"><h3>State</h3><div class="value">${OViz.badge(o.state)}</div><div class="sub">${OViz.escapeHtml(status.project ?? '—')}</div></div>
        <div class="card"><h3>Uptime</h3><div class="value">${OViz.fmtDuration(o.uptimeMs)}</div></div>
        <div class="card"><h3>Session</h3><div class="value">${session ? OViz.badge(session.state) : '—'}</div><div class="sub">${session ? OViz.escapeHtml(session.id.slice(0, 8)) : ''}</div></div>
        <div class="card"><h3>Agent</h3><div class="value">${agent?.pid ? `pid ${agent.pid}` : '—'}</div><div class="sub">${OViz.escapeHtml(agent?.driver ?? '')}</div></div>
        <div class="card"><h3>Runs</h3><div class="value">${counters.runs ?? 0}</div><div class="sub">resumes ${counters.resumes ?? 0} · crashes ${counters.crashes ?? 0}</div></div>
        <div class="card"><h3>Current activity</h3><div class="value" style="font-size:14px">${OViz.escapeHtml(activity.currentTask ?? '—')}</div><div class="sub">last output ${OViz.fmtDate(activity.lastOutputAt)}</div></div>
      </div>
      ${mission?.mode === 'tasks' ? `
        <div class="section">
          <div class="section-title">Mission progress</div>
          <div class="card">Task ${OViz.escapeHtml(mission.currentTaskId ?? '(all done)')} — ${mission.taskIndex + 1}/${mission.totalTasks} ${OViz.badge(mission.taskState)} (attempts ${mission.taskAttempts})</div>
        </div>` : ''}
      ${rateLimit.waiting ? `
        <div class="section">
          <div class="card" style="border-color:var(--yellow)">Rate limited — resuming at ${OViz.fmtDate(rateLimit.resumeAt)}</div>
        </div>` : ''}
    `;

    const projectCards = projects.length
      ? `<div class="grid">${projects.map((p) => `
          <div class="card" data-project="${OViz.escapeHtml(p.name)}" style="cursor:pointer;${p.name === selectedProject ? 'border-color:var(--accent)' : ''}">
            <h3>${p.hasActiveSession ? 'Active' : 'Idle'}</h3>
            <div class="value" style="font-size:15px">${OViz.escapeHtml(p.name)}</div>
          </div>`).join('')}</div>`
      : OViz.empty('No projects defined yet — create one from the Missions tab.');

    return `${cards}<div class="section"><div class="section-title">Projects</div>${projectCards}</div>`;
  }

  async function render(root, ctx) {
    const [status, projects] = await Promise.all([ctx.api.getStatus(), ctx.api.listProjects()]);
    root.innerHTML = html(status, projects, ctx.project);
    root.querySelectorAll('[data-project]').forEach((el) => {
      el.addEventListener('click', () => ctx.setProject(el.dataset.project));
    });
  }

  return { mount: render, tick: render };
})();
