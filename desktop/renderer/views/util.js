window.OViz = (function () {
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function badge(state) {
    const s = String(state ?? 'unknown');
    return `<span class="badge ${escapeHtml(s)}">${escapeHtml(s)}</span>`;
  }

  function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  }

  function fmtDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const s = Math.floor(ms / 1000);
    const parts = [];
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (mins) parts.push(`${mins}m`);
    if (!days && !hours) parts.push(`${secs}s`);
    return parts.join(' ');
  }

  function empty(text) {
    return `<div class="empty">${escapeHtml(text)}</div>`;
  }

  return { escapeHtml, badge, fmtDate, fmtDuration, empty };
})();
