window.Views = window.Views || {};
window.Views.settings = (function () {
  let tokenRevealed = false;

  async function render(root, ctx) {
    const [token, paths, config, projects] = await Promise.all([
      ctx.api.getApiToken(), ctx.api.getPaths(), ctx.api.getGlobalConfig(), ctx.api.listProjects(),
    ]);
    const details = await Promise.all(projects.map((p) => ctx.api.getProjectDetails(p.name)));
    const shown = tokenRevealed ? token : token.replace(/./g, '•').slice(0, 24);

    root.innerHTML = `
      <div class="section">
        <div class="section-title">Dashboard API token</div>
        <div class="card">
          <div class="row between">
            <code class="mono" id="token-value">${OViz.escapeHtml(shown)}</code>
            <div class="row">
              <button class="btn small" id="toggle-token">${tokenRevealed ? 'Hide' : 'Reveal'}</button>
              <button class="btn small" id="copy-token">Copy</button>
              <button class="btn small danger" id="rotate-token">Rotate</button>
            </div>
          </div>
          <div class="sub" style="margin-top:8px">Required for every mutating dashboard API call (stop, task/memory edits) while an orchestrator is running. Rotating invalidates the previous token immediately.</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Project locations</div>
        ${details.length ? `<table><thead><tr><th>Project</th><th>Driver</th><th>Working directory</th><th></th></tr></thead><tbody>
          ${details.map((d) => d.error
            ? `<tr><td>${OViz.escapeHtml(d.name)}</td><td colspan="3" style="color:var(--red)">${OViz.escapeHtml(d.error)}</td></tr>`
            : `<tr><td>${OViz.escapeHtml(d.name)}</td><td>${OViz.escapeHtml(d.driver)}</td><td class="mono">${OViz.escapeHtml(d.workingDirectory)}</td><td><button class="btn small" data-open="${OViz.escapeHtml(d.workingDirectory)}">Open folder</button></td></tr>`
          ).join('')}
        </tbody></table>` : OViz.empty('No projects defined yet.')}
      </div>

      <div class="section">
        <div class="section-title">Configuration files</div>
        <div class="card">
          <dl class="kv">
            <dt>Global config</dt><dd class="mono">${OViz.escapeHtml(paths.configDir)}/orchestrator.json <button class="btn small" data-open="${OViz.escapeHtml(paths.configDir)}/orchestrator.json">Open</button></dd>
            <dt>Project configs</dt><dd class="mono">${OViz.escapeHtml(paths.projectsDir)} <button class="btn small" data-open="${OViz.escapeHtml(paths.projectsDir)}">Open</button></dd>
            <dt>Logs</dt><dd class="mono">${OViz.escapeHtml(paths.logsDir)} <button class="btn small" data-open="${OViz.escapeHtml(paths.logsDir)}">Open</button></dd>
            <dt>Runtime state</dt><dd class="mono">${OViz.escapeHtml(paths.stateDir)} <button class="btn small" data-open="${OViz.escapeHtml(paths.stateDir)}">Open</button></dd>
          </dl>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Notifications (read-only — edit via the config file above)</div>
        <div class="card"><pre class="mono" style="white-space:pre-wrap;margin:0">${OViz.escapeHtml(JSON.stringify(config.notifications, null, 2))}</pre></div>
      </div>
    `;

    root.querySelector('#toggle-token')?.addEventListener('click', () => {
      tokenRevealed = !tokenRevealed;
      render(root, ctx);
    });
    root.querySelector('#copy-token')?.addEventListener('click', () => {
      ctx.api.copyText(token);
      ctx.toast('Token copied to clipboard.', 'success');
    });
    root.querySelector('#rotate-token')?.addEventListener('click', async () => {
      if (!confirm('Rotate the API token? Anything using the old token (e.g. this app after restart is fine, but external scripts are not) will need the new one.')) return;
      await ctx.api.rotateApiToken();
      tokenRevealed = true;
      ctx.toast('Token rotated.', 'success');
      render(root, ctx);
    });
    root.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => ctx.api.openPath(el.dataset.open));
    });
  }

  return { mount: render };
})();
