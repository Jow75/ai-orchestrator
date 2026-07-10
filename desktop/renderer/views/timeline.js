window.Views = window.Views || {};
window.Views.timeline = (function () {
  async function render(root, ctx) {
    if (!ctx.project) {
      root.innerHTML = OViz.empty('Select a project first.');
      return;
    }
    const entries = await ctx.api.getTimeline(ctx.project);
    const items = [...entries].reverse().map((e) => `
      <div class="timeline-item ${OViz.escapeHtml(e.event)}">
        <div class="dot"></div>
        <div class="time">${OViz.fmtDate(e.at)}</div>
        <div>${OViz.escapeHtml(e.label)}</div>
      </div>`).join('');

    root.innerHTML = `
      <div class="section">
        <div class="row between"><div class="section-title">Mission timeline — ${OViz.escapeHtml(ctx.project)}</div><button class="btn small" id="refresh">Refresh</button></div>
        ${entries.length ? `<div class="timeline-list">${items}</div>` : OViz.empty('No timeline recorded for this project yet.')}
      </div>
    `;
    root.querySelector('#refresh')?.addEventListener('click', () => render(root, ctx));
  }

  return { mount: render };
})();
