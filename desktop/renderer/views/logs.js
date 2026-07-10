window.Views = window.Views || {};
window.Views.logs = (function () {
  let selectedFile = null;

  function appendLines(root, lines) {
    const container = root.querySelector('#log-lines');
    if (!container || !lines.length) return;
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 12;
    for (const entry of lines) {
      const div = document.createElement('div');
      div.className = `log-line ${entry.level ?? ''}`;
      const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
      const mod = entry.module ? `(${entry.module}) ` : '';
      const level = entry.level ? `[${entry.level}] ` : '';
      div.textContent = `${time ? `${time}  ` : ''}${level}${mod}${entry.message ?? ''}`;
      container.appendChild(div);
    }
    while (container.childNodes.length > 1000) container.removeChild(container.firstChild);
    if (atBottom) container.scrollTop = container.scrollHeight;
  }

  async function mount(root, ctx) {
    const files = await ctx.api.listLogFiles();
    const defaultFile = await ctx.api.getDefaultLogFile();
    selectedFile = files.includes(defaultFile) ? defaultFile : (files[0] ?? null);

    root.innerHTML = `
      <div class="section" style="height:calc(100vh - 150px); display:flex; flex-direction:column;">
        <div class="row between">
          <div class="section-title">Logs</div>
          <select id="file-select">${
            files.length
              ? files.map((f) => `<option value="${OViz.escapeHtml(f)}" ${f === selectedFile ? 'selected' : ''}>${OViz.escapeHtml(f)}</option>`).join('')
              : '<option>(none yet)</option>'
          }</select>
        </div>
        <div class="sub" style="margin-bottom:8px">System/lifecycle events only — raw agent conversation output isn't persisted to disk (see desktop/README.md).</div>
        <div class="log-lines" id="log-lines" style="flex:1"></div>
      </div>
    `;

    if (selectedFile) {
      await ctx.api.resetLog(selectedFile);
      appendLines(root, await ctx.api.pollLog(selectedFile));
    } else {
      root.querySelector('#log-lines').innerHTML = OViz.empty('No log files yet — logs appear once a mission has run.');
    }

    root.querySelector('#file-select')?.addEventListener('change', async (e) => {
      selectedFile = e.target.value;
      await ctx.api.resetLog(selectedFile);
      root.querySelector('#log-lines').innerHTML = '';
      appendLines(root, await ctx.api.pollLog(selectedFile));
    });
  }

  async function tick(root, ctx) {
    if (!selectedFile || !root.querySelector('#log-lines')) return;
    appendLines(root, await ctx.api.pollLog(selectedFile));
  }

  return { mount, tick };
})();
