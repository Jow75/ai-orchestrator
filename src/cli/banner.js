/**
 * cli/banner.js — Phase 11 M4: a concise startup banner.
 *
 * Printed once when supervision begins, before the log stream starts, so the
 * operator sees at a glance what's about to run: version, project(s),
 * operating mode, and which notification channels will actually reach them.
 * Purely informational — never throws; a banner that failed to compute a
 * detail just omits it rather than blocking a real mission from starting.
 */

import { VERSION } from '../infra/version.js';
import { effectiveApprovalConfig } from '../approvals/approvalPolicy.js';

/** Config key → the label shown when that channel is enabled. */
const CHANNEL_LABELS = Object.freeze({
  desktop: 'desktop', webhook: 'webhook', discord: 'discord', telegram: 'Telegram', email: 'email',
});

/**
 * Assemble the banner's data (no formatting/color — see {@link renderStartupBanner}).
 *
 * @param {object} params
 * @param {string[]} [params.projectNames] - Projects about to be supervised.
 * @param {import('../config/configManager.js').ConfigManager} params.configManager
 * @returns {{version: string, projects: string[], mode: string, channels: string[]}}
 */
export function buildStartupBanner({ projectNames, configManager }) {
  const config = configManager.getAll();
  const requested = (projectNames ?? []).filter(Boolean);
  const projects = requested.length ? requested : [config.defaultProject].filter(Boolean);

  let mode = 'approvals disabled';
  if (config.approvals?.enabled !== false) {
    const known = new Set();
    for (const name of projects) {
      try {
        if (configManager.listProjects().includes(name)) {
          const project = configManager.getProject(name);
          known.add(effectiveApprovalConfig(config.approvals, project).mode ?? 'balanced');
        }
      } catch {
        // Cosmetic only — an unresolvable project here is reported properly
        // (with a fix) once the real start sequence gets to it.
      }
    }
    mode = known.size ? [...known].join(', ') : (config.approvals?.mode ?? 'balanced');
  }

  const channels = Object.entries(CHANNEL_LABELS)
    .filter(([key]) => config.notifications?.[key]?.enabled)
    .map(([, label]) => label);

  return {
    version: VERSION,
    projects: projects.length ? projects : ['(no project — set "defaultProject" or pass one)'],
    mode,
    channels,
  };
}

/**
 * Render the banner as colored, phone-and-terminal-friendly text.
 *
 * @param {ReturnType<typeof buildStartupBanner>} banner
 * @param {object} [chalkInstance] - Injectable for tests; defaults to no color.
 * @returns {string}
 */
export function renderStartupBanner(banner, chalkInstance) {
  const c = chalkInstance ?? { bold: (s) => s, dim: (s) => s, cyan: (s) => s };
  const label = banner.projects.length > 1 ? 'Projects' : 'Project';
  return [
    c.bold(`AI-Orchestrator v${banner.version}`),
    `${label}: ${banner.projects.join(', ')}`,
    `Mode: ${banner.mode}`,
    `Notifications: ${banner.channels.length ? banner.channels.join(', ') : 'none configured'}`,
    c.dim('Nothing will interrupt you except owner-gate approvals.'),
  ].join('\n');
}

export default { buildStartupBanner, renderStartupBanner };
