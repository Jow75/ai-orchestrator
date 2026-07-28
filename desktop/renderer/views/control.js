window.Views = window.Views || {};
/**
 * views/control.js — Phase 12 M3: the Operator Control Center.
 *
 * Every other view in this app answers a question about ONE project, chosen
 * from the picker in the header. That was the right shape when one orchestrator
 * could supervise one project at a time. The Core Service supervises several at
 * once and answers a phone while doing it, and the question an owner actually
 * opens the desktop with is not "how is alpha doing" — it is:
 *
 *     Is the service up, what is it running, and what is waiting on me?
 *
 * So this view is deliberately NOT project-scoped. It reads the same
 * `/api/registry` the phone's `/projects` renders and the same `/api/daemon`
 * that `/service` answers from, because three surfaces disagreeing about what
 * "blocked" means is the drift Phase 11 M4 removed.
 *
 * It is also the first desktop surface to disclose a simulated project, closing
 * the last gap left by v2.10.0 — the desktop was the one place a fixture
 * mission could still look exactly like real work.
 */
window.Views.control = (function () {
  const SIMULATION_NOTICE =
    'Simulated project — the engine is a scripted fixture. ' +
    'No code is written, no tests are run, and any result below is a rehearsal, not work.';

  /** The service header: the two questions, answered before anything else. */
  function serviceCard(service) {
    if (!service?.running) {
      // A crashed service and one that was never started need different
      // remedies, so they get different sentences rather than one vague red box.
      const detail = service?.stale
        ? 'Its record points at a process that is gone — it crashed or the machine lost power.'
        : (service?.reason ?? 'The Core Service is not running.');
      return `
        <div class="card" style="border-color:var(--red)">
          <h3>Core Service</h3>
          <div class="value" style="font-size:15px">Stopped</div>
          <div class="sub">${OViz.escapeHtml(detail)}</div>
          <div class="sub">Start it: <code>ai-orchestrator daemon ensure</code> — or double-click START_SERVICE.bat</div>
        </div>`;
    }
    const reboot = service.autostart?.installed
      ? 'survives a reboot ✔'
      : 'will NOT come back after a reboot — run "daemon install"';
    return `
      <div class="grid">
        <div class="card"><h3>Core Service</h3><div class="value" style="font-size:15px">Running</div>
          <div class="sub">pid ${OViz.escapeHtml(service.pid)} · v${OViz.escapeHtml(service.version)}</div></div>
        <div class="card"><h3>Uptime</h3><div class="value">${OViz.fmtDuration(service.uptimeMs)}</div>
          <div class="sub">${OViz.escapeHtml(reboot)}</div></div>
        <div class="card"><h3>Missions</h3><div class="value">${service.workers ?? 0}${service.maxWorkers ? ` / ${service.maxWorkers}` : ''}</div>
          <div class="sub">running in parallel</div></div>
        <div class="card"><h3>Remote</h3><div class="value" style="font-size:15px">${service.telegramInbound ? 'Telegram live' : 'No inbound channel'}</div>
          <div class="sub">${service.telegramInbound ? 'your phone will be answered' : 'commands from a phone will not arrive'}</div></div>
      </div>`;
  }

  /** One project, with the state an operator decides on. */
  function projectRow(record, selected) {
    const detail = [];
    if (record.tasks?.total) detail.push(`${record.tasks.done}/${record.tasks.total} tasks`);
    if (record.git?.branch) detail.push(OViz.escapeHtml(record.git.branch));
    if (record.worker) detail.push(`pid ${record.worker.pid}`);
    if (record.health?.level) detail.push(OViz.escapeHtml(record.health.level));

    const waiting = record.pendingApprovals?.length
      ? `<div class="sub" style="color:var(--yellow)">Waiting on you: ${record.pendingApprovals.map((r) => OViz.escapeHtml(r.id)).join(', ')}</div>`
      : '';
    // The badge rides on the NAME, not the detail line, for the same reason it
    // does on a phone: the detail line is what gets skimmed past.
    const badge = record.simulated
      ? ' <span class="badge" style="background:var(--yellow);color:#000">🧪 SIMULATED</span>'
      : '';
    const notice = record.simulated
      ? `<div class="sub" style="color:var(--yellow)">${OViz.escapeHtml(SIMULATION_NOTICE)}</div>`
      : '';
    const running = Boolean(record.worker);

    return `
      <div class="card" data-project="${OViz.escapeHtml(record.name)}"
           style="cursor:pointer;${record.name === selected ? 'border-color:var(--accent)' : ''}">
        <h3>${OViz.badge(record.status ?? 'idle')}</h3>
        <div class="value" style="font-size:15px">${OViz.escapeHtml(record.name)}${badge}</div>
        <div class="sub">${detail.join(' · ') || '—'}</div>
        ${waiting}
        ${notice}
        <div class="row" style="margin-top:8px">
          <button class="btn" data-action="${running ? 'stop' : 'start'}"
                  data-target="${OViz.escapeHtml(record.name)}">${running ? 'Stop' : 'Start'}</button>
        </div>
      </div>`;
  }

  function html(service, registry, approvals, selected) {
    const projects = registry?.records ?? [];
    const list = projects.length
      ? `<div class="grid">${projects.map((r) => projectRow(r, selected)).join('')}</div>`
      : OViz.empty('No projects defined yet — create one from the Missions tab.');

    const waiting = approvals.length
      ? `<div class="grid">${approvals.map((a) => `
          <div class="card" style="border-color:var(--yellow)">
            <h3>${OViz.escapeHtml(a.project)}${a.simulated ? ' 🧪' : ''}</h3>
            <div class="value" style="font-size:14px">${OViz.escapeHtml(a.title ?? a.id)}</div>
            <div class="sub">${OViz.escapeHtml(a.id)} · open the Approvals tab to decide</div>
          </div>`).join('')}</div>`
      : OViz.empty('Nothing is waiting for your decision.');

    // Said plainly rather than hidden: without the service these records come
    // from local files and cannot know about workers or branches.
    const sourceNote = registry?.source === 'local'
      ? '<div class="sub">The Core Service is not running — this list is read from local files and cannot show live missions.</div>'
      : '';

    return `
      ${serviceCard(service)}
      <div class="section"><div class="section-title">Projects</div>${sourceNote}${list}</div>
      <div class="section"><div class="section-title">Waiting for you</div>${waiting}</div>
    `;
  }

  async function render(root, ctx) {
    const [service, registry, approvals] = await Promise.all([
      ctx.api.getServiceStatus(),
      ctx.api.getRegistry({ health: true, git: true }),
      ctx.api.getAllApprovals(),
    ]);
    root.innerHTML = html(service, registry, approvals ?? [], ctx.project);

    root.querySelectorAll('[data-project]').forEach((el) => {
      el.addEventListener('click', (event) => {
        // A click on Start/Stop is not a click on the card.
        if (event.target.closest('[data-action]')) return;
        ctx.setProject(el.dataset.project);
      });
    });

    root.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', async () => {
        const project = el.dataset.target;
        el.disabled = true;
        const result = el.dataset.action === 'start'
          ? await ctx.api.startMission(project, {})
          // The project is REQUIRED here: under the service, an unqualified
          // stop cannot be resolved and would be refused.
          : await ctx.api.stopMission('stopped from the Control Center', project);
        ctx.toast(
          result?.ok ? `${project}: ${el.dataset.action === 'start' ? 'mission started' : 'stopping'}`
            : `${project}: ${result?.reason ?? 'failed'}`,
          result?.ok ? 'info' : 'error'
        );
        render(root, ctx);
      });
    });
  }

  return { mount: render, tick: render };
})();
