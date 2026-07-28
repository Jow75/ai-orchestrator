window.Views = window.Views || {};
window.Views.missions = (function () {
  // Phase 10D: the standardized lifecycle rendered as a strip + recent history.
  const LIFECYCLE_BADGE = {
    completed: 'done', approved: 'done', executing: 'active', verifying: 'active',
    'agents-assigned': 'active', 'approval-pending': 'active', fixing: 'active',
    blocked: 'failed', failed: 'failed', cancelled: 'idle',
  };

  function lifecycleSection(lifecycle, project) {
    if (!lifecycle) return '';
    const history = (lifecycle.history ?? []).slice(-6).reverse().map((entry) => `
      <div class="sub">${OViz.fmtDate(entry.at)} — ${OViz.escapeHtml(entry.from ?? '(start)')} → <b>${OViz.escapeHtml(entry.to)}</b>${entry.reason ? ` · ${OViz.escapeHtml(entry.reason)}` : ''}</div>`).join('');
    return `
      <div class="section">
        <div class="section-title">Mission lifecycle — ${OViz.escapeHtml(project)}</div>
        <div class="card">
          <div class="row">
            <span class="badge ${LIFECYCLE_BADGE[lifecycle.state] ?? 'idle'}" style="font-size:13px">${OViz.escapeHtml(lifecycle.state)}</span>
            <span class="sub">updated ${OViz.fmtDate(lifecycle.updatedAt)}</span>
          </div>
          <div style="margin-top:10px">${history || '<div class="sub">(no transitions yet)</div>'}</div>
        </div>
      </div>`;
  }

  async function render(root, ctx) {
    const [live, drivers, projects, lifecycle] = await Promise.all([
      // Phase 12 M3: THIS project's own liveness, not "is any API reachable".
      // Under the Core Service, getHealth() answers true the instant ANY
      // project has a worker — gating one project's buttons on it would show
      // every idle project as running the moment the machine's normal state
      // (the service, up) was reached.
      ctx.project ? ctx.api.isProjectLive(ctx.project) : Promise.resolve(false),
      ctx.api.listDrivers(), ctx.api.listProjects(),
      ctx.project ? ctx.api.getLifecycle(ctx.project) : Promise.resolve(null),
    ]);
    const current = projects.find((p) => p.name === ctx.project);

    root.innerHTML = `
      ${lifecycleSection(lifecycle, ctx.project)}
      <div class="section">
        <div class="section-title">Mission control</div>
        <div class="card">
          <div class="row between">
            <div>
              <div class="value" style="font-size:16px">${OViz.escapeHtml(ctx.project || '(no project selected)')}</div>
              <div class="sub">${live ? 'An orchestrator is currently running.' : (current ? 'Idle — ready to start.' : 'Create or select a project below.')}</div>
            </div>
            <div class="row">
              <label class="row" style="font-size:12px;color:var(--text-dim)"><input type="checkbox" id="fresh-check" ${live ? 'disabled' : ''}/> fresh start</label>
              <button class="btn primary" id="start-btn" ${live || !ctx.project ? 'disabled' : ''}>Start</button>
              <button class="btn danger" id="stop-btn" ${live ? '' : 'disabled'}>Stop</button>
            </div>
          </div>
          <div class="sub" style="margin-top:10px">
            Stop is graceful and resumable — starting the same project again resumes it (there is no separate "pause" state).
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Create a new project</div>
        <div class="card">
          <form class="form" id="create-form">
            <label>Project name <input name="name" required pattern="[A-Za-z0-9_-]+" placeholder="my-project" /></label>
            <label>Working directory
              <div class="row"><input name="dir" required readonly placeholder="Pick a folder…" style="flex:1" /><button type="button" class="btn small" id="pick-dir">Browse…</button></div>
            </label>
            <label>Mission prompt file (relative to working directory, or absolute)
              <div class="row"><input name="promptFile" required placeholder="prompts/mission.md" style="flex:1" /><button type="button" class="btn small" id="pick-file">Browse…</button></div>
            </label>
            <label>Driver
              <select name="driver">${drivers.map((d) => `<option value="${OViz.escapeHtml(d)}">${OViz.escapeHtml(d)}</option>`).join('')}</select>
            </label>
            <div class="row"><button type="submit" class="btn primary">Create project</button></div>
          </form>
        </div>
      </div>
    `;

    root.querySelector('#start-btn')?.addEventListener('click', async () => {
      const fresh = root.querySelector('#fresh-check').checked;
      const result = await ctx.api.startMission(ctx.project, { fresh });
      ctx.toast(result.ok ? `Starting "${ctx.project}"…` : `Could not start: ${result.reason}`, result.ok ? 'success' : 'error');
      setTimeout(() => render(root, ctx), 800);
    });

    root.querySelector('#stop-btn')?.addEventListener('click', async () => {
      // The project is passed explicitly: under the Core Service several
      // missions can run at once, so an unqualified stop cannot be resolved
      // and the bridge refuses it rather than guessing which one was meant.
      const result = await ctx.api.stopMission('stopped from desktop app', ctx.project);
      ctx.toast(result.ok ? 'Stop requested.' : `Could not stop: ${result.reason}`, result.ok ? 'success' : 'error');
      setTimeout(() => render(root, ctx), 800);
    });

    root.querySelector('#pick-dir')?.addEventListener('click', async () => {
      const dir = await ctx.api.pickDirectory();
      if (dir) root.querySelector('[name="dir"]').value = dir;
    });

    root.querySelector('#pick-file')?.addEventListener('click', async () => {
      const file = await ctx.api.pickFile();
      if (file) root.querySelector('[name="promptFile"]').value = file;
    });

    root.querySelector('#create-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const name = form.get('name');
      const result = await ctx.api.createProject(name, {
        dir: form.get('dir'), promptFile: form.get('promptFile'), driver: form.get('driver'),
      });
      if (result.ok) {
        ctx.toast(`Project "${name}" created.`, 'success');
        ctx.setProject(name);
      } else {
        ctx.toast(`Could not create project: ${result.reason}`, 'error');
      }
    });
  }

  return { mount: render };
})();
