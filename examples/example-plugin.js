/**
 * example-plugin.js — A minimal AI-Orchestrator plugin.
 *
 * To activate: copy this file into the plugins/ directory and restart the
 * orchestrator. See API.md for the full plugin contract.
 */

export default {
  name: 'example-plugin',
  version: '1.0.0',

  /**
   * Called once at startup.
   *
   * @param {object} context
   * @param {import('../src/core/orchestrator.js').Orchestrator} context.orchestrator
   * @param {import('../src/drivers/driverRegistry.js').DriverRegistry} context.driverRegistry
   * @param {object} context.config - The full merged global configuration.
   * @param {object} context.logger - A logger scoped to this plugin.
   */
  async initialize({ orchestrator, logger }) {
    orchestrator.on('session:launched', ({ project, pid, resumed }) => {
      logger.info(`Agent ${resumed ? 'resumed' : 'launched'} for ${project} (pid ${pid})`);
    });

    orchestrator.on('mission:complete', ({ project, summary }) => {
      logger.info(`Mission complete for ${project}: ${summary}`);
      // Ideas: push to a spreadsheet, trigger a deploy, start the next mission...
    });
  },

  /** Optional: called on clean shutdown. */
  async shutdown() {},
};
