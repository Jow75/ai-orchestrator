(function () {
  const api = window.orchestrator;
  const TAB_LABELS = {
    control: 'Control Center',
    dashboard: 'Dashboard', missions: 'Missions', tasks: 'Tasks', agents: 'Agents', approvals: 'Approvals',
    timeline: 'Timeline', memory: 'Memory Center', logs: 'Logs', settings: 'Settings',
  };

  // Phase 12 M3: the Control Center lands first. Every other tab answers a
  // question about ONE project; the question an owner opens this app with is
  // "is the service up, what is running, and what is waiting on me?".
  const state = { project: localStorage.getItem('ao:project') || '', tab: 'control' };

  const viewRoot = document.getElementById('view-root');
  const viewTitle = document.getElementById('view-title');
  const panelFor = (tab) => viewRoot.querySelector(`[data-view="${tab}"]`);
  const projectSelect = document.getElementById('project-select');
  const liveBadge = document.getElementById('live-badge');
  const navButtons = [...document.querySelectorAll('.nav-item')];
  const toastRoot = document.getElementById('toast-root');

  function toast(message, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    toastRoot.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  function ctx() {
    return {
      api,
      project: state.project,
      toast,
      setProject(name) {
        state.project = name;
        localStorage.setItem('ao:project', name);
        projectSelect.value = name;
        mountCurrentTab();
      },
    };
  }

  async function refreshProjects() {
    const projects = await api.listProjects();
    const previous = state.project;
    projectSelect.innerHTML = projects.length
      // The 🧪 marker is in the PICKER because that is where a fixture project
      // is chosen — a mission on one completes, verifies and writes nothing.
      ? projects.map((p) => `<option value="${OViz.escapeHtml(p.name)}">${OViz.escapeHtml(p.name)}${p.simulated ? ' 🧪 simulated' : ''}${p.hasActiveSession ? ' (active)' : ''}</option>`).join('')
      : '<option value="">(no projects yet)</option>';
    const stillExists = projects.some((p) => p.name === previous);
    state.project = stillExists ? previous : (projects[0]?.name ?? '');
    projectSelect.value = state.project;
    return projects;
  }

  /**
   * Phase 12 M3. This badge used to read `getHealth()`, which only ever knew
   * about a standalone orchestrator — so with the Core Service supervising two
   * missions and answering a phone, the desktop said "Idle — no orchestrator
   * running". The service is asked first because it is the thing that is
   * usually running.
   */
  async function refreshLiveBadge() {
    const service = await api.getServiceStatus();
    if (service?.running) {
      const missions = service.workers ?? 0;
      liveBadge.textContent = `Core Service — ${missions} mission${missions === 1 ? '' : 's'}`;
      liveBadge.className = 'live-indicator live';
      return;
    }
    const health = await api.getHealth();
    if (health?.ok) {
      liveBadge.textContent = `Live — pid ${health.pid}`;
      liveBadge.className = 'live-indicator live';
    } else {
      // Distinguished, because they need different remedies.
      liveBadge.textContent = service?.stale
        ? 'Core Service crashed — restart it'
        : 'Idle — Core Service not running';
      liveBadge.className = 'live-indicator idle';
    }
  }

  function mountCurrentTab() {
    navButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    viewTitle.textContent = TAB_LABELS[state.tab];
    Object.keys(TAB_LABELS).forEach((tab) => panelFor(tab).classList.toggle('active', tab === state.tab));
    const view = window.Views[state.tab];
    view.mount(panelFor(state.tab), ctx());
  }

  function setTab(tab) {
    state.tab = tab;
    mountCurrentTab();
  }

  navButtons.forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  projectSelect.addEventListener('change', (e) => ctx().setProject(e.target.value));

  async function poll() {
    await refreshLiveBadge();
    const view = window.Views[state.tab];
    if (view.tick) view.tick(panelFor(state.tab), ctx());
  }

  (async function init() {
    await refreshProjects();
    mountCurrentTab();
    poll();
    setInterval(poll, 2000);
    setInterval(refreshProjects, 5000);
  })();
})();
