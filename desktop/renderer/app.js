(function () {
  const api = window.orchestrator;
  const TAB_LABELS = {
    dashboard: 'Dashboard', missions: 'Missions', tasks: 'Tasks',
    timeline: 'Timeline', memory: 'Memory Center', logs: 'Logs', settings: 'Settings',
  };

  const state = { project: localStorage.getItem('ao:project') || '', tab: 'dashboard' };

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
      ? projects.map((p) => `<option value="${OViz.escapeHtml(p.name)}">${OViz.escapeHtml(p.name)}${p.hasActiveSession ? ' (active)' : ''}</option>`).join('')
      : '<option value="">(no projects yet)</option>';
    const stillExists = projects.some((p) => p.name === previous);
    state.project = stillExists ? previous : (projects[0]?.name ?? '');
    projectSelect.value = state.project;
    return projects;
  }

  async function refreshLiveBadge() {
    const health = await api.getHealth();
    if (health?.ok) {
      liveBadge.textContent = `Live — pid ${health.pid}`;
      liveBadge.className = 'live-indicator live';
    } else {
      liveBadge.textContent = 'Idle — no orchestrator running';
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
