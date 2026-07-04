/**
 * pluginManager.js — Plugin System.
 *
 * Future integrations extend AI-Orchestrator without touching its code.
 * A plugin is a JS module in the `plugins/` directory (either
 * `plugins/<name>.js` or `plugins/<name>/index.js`) whose default export is:
 *
 *   export default {
 *     name: 'my-plugin',
 *     version: '1.0.0',
 *     // Called once at startup. Subscribe to orchestrator events,
 *     // register new AI drivers, read config — whatever the plugin needs.
 *     async initialize({ orchestrator, driverRegistry, config, logger }) { ... },
 *     // Optional: called on clean shutdown.
 *     async shutdown() { ... },
 *   };
 *
 * Plugins are sandboxed by policy, not by mechanism: a plugin that throws
 * during load or initialize is skipped and logged — it can never take the
 * supervisor down.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class PluginManager {
  /**
   * @param {object} options
   * @param {string} options.pluginsDir - Directory scanned for plugins.
   * @param {object} options.logger - Module logger.
   */
  constructor({ pluginsDir, logger }) {
    this.pluginsDir = pluginsDir;
    this.logger = logger;
    this.plugins = [];
  }

  /** Discover plugin entry files in the plugins directory. */
  discover() {
    if (!fs.existsSync(this.pluginsDir)) return [];

    const entries = [];
    for (const item of fs.readdirSync(this.pluginsDir, { withFileTypes: true })) {
      if (item.isFile() && item.name.endsWith('.js')) {
        entries.push(path.join(this.pluginsDir, item.name));
      } else if (item.isDirectory()) {
        const index = path.join(this.pluginsDir, item.name, 'index.js');
        if (fs.existsSync(index)) entries.push(index);
      }
    }
    return entries;
  }

  /**
   * Load and initialize every discovered plugin.
   *
   * @param {object} context - Passed to each plugin's initialize():
   *   { orchestrator, driverRegistry, config, logger }.
   */
  async loadAll(context) {
    for (const entryFile of this.discover()) {
      await this.loadOne(entryFile, context);
    }
    if (this.plugins.length) {
      this.logger.info('Plugins loaded', {
        plugins: this.plugins.map((p) => `${p.name}@${p.version ?? '?'}`),
      });
    }
  }

  /** Load a single plugin, isolating any failure to that plugin. */
  async loadOne(entryFile, context) {
    try {
      const module = await import(pathToFileURL(entryFile).href);
      const plugin = module.default;

      if (!plugin || typeof plugin.initialize !== 'function' || !plugin.name) {
        this.logger.warn('Skipping invalid plugin (needs default export with name + initialize)', {
          file: entryFile,
        });
        return;
      }

      await plugin.initialize({
        ...context,
        logger: this.logger.child({ module: `plugin:${plugin.name}` }),
      });
      this.plugins.push(plugin);
      this.logger.info('Plugin initialized', { plugin: plugin.name });
    } catch (error) {
      this.logger.error('Plugin failed to load — skipped', {
        file: entryFile,
        error: error.message,
      });
    }
  }

  /** Shut down all plugins that expose a shutdown hook (best-effort). */
  async shutdownAll() {
    for (const plugin of this.plugins) {
      try {
        await plugin.shutdown?.();
      } catch (error) {
        this.logger.warn('Plugin shutdown failed', {
          plugin: plugin.name,
          error: error.message,
        });
      }
    }
  }
}

export default PluginManager;
