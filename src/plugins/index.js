import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

export class PluginManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.plugins = new Map();
    this.hooks = new Map();
    this.pluginDir = this.config.pluginDir || './plugins';
    this.enabledPlugins = new Set(this.config.enabledPlugins || []);
  }

  async loadPlugin(name, pluginPath = null) {
    const fullPath = pluginPath || path.join(this.pluginDir, name, 'index.js');

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Plugin not found: ${fullPath}`);
    }

    const pluginModule = await import(fullPath);
    const PluginClass = pluginModule.default || pluginModule[name] || pluginModule.Plugin;

    if (!PluginClass) {
      throw new Error(`Plugin ${name} does not export a valid class`);
    }

    const plugin = new PluginClass({
      logger: this.logger,
      config: this.config.plugins?.[name] || {}
    });

    if (typeof plugin.initialize !== 'function') {
      throw new Error(`Plugin ${name} must implement initialize()`);
    }

    await plugin.initialize(this);

    this.plugins.set(name, { instance: plugin, path: fullPath, loadedAt: new Date() });

    if (this.enabledPlugins.has(name) || this.config.autoEnable !== false) {
      await this.enablePlugin(name);
    }

    this.emit('plugin:loaded', { name, plugin });
    this.logger.info(`Plugin loaded: ${name}`);

    return plugin;
  }

  async loadAllPlugins() {
    if (!fs.existsSync(this.pluginDir)) {
      this.logger.debug('Plugin directory not found', { dir: this.pluginDir });
      return;
    }

    const entries = fs.readdirSync(this.pluginDir, { withFileTypes: true });
    const pluginDirs = entries.filter(e => e.isDirectory()).map(e => e.name);

    for (const name of pluginDirs) {
      try {
        await this.loadPlugin(name);
      } catch (error) {
        this.logger.error(`Failed to load plugin ${name}`, { error: error.message });
      }
    }
  }

  async enablePlugin(name) {
    const entry = this.plugins.get(name);
    if (!entry) throw new Error(`Plugin not loaded: ${name}`);

    if (typeof instance.enable === 'function') {
      await instance.enable();
    }

    this.enabledPlugins.add(name);
    this.emit('plugin:enabled', { name });
    this.logger.info(`Plugin enabled: ${name}`);
  }

  async disablePlugin(name) {
    const entry = this.plugins.get(name);
    if (!entry) throw new Error(`Plugin not loaded: ${name}`);

    if (typeof instance.disable === 'function') {
      await instance.disable();
    }

    this.enabledPlugins.delete(name);
    this.emit('plugin:disabled', { name });
    this.logger.info(`Plugin disabled: ${name}`);
  }

  getPlugin(name) {
    const entry = this.plugins.get(name);
    return entry?.instance || null;
  }

  getAllPlugins() {
    return Array.from(this.plugins.entries()).map(([name, entry]) => ({
      name,
      enabled: this.enabledPlugins.has(name),
      loadedAt: entry.loadedAt,
      path: entry.path
    }));
  }

  registerHook(hookName, handler, pluginName) {
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, []);
    }

    this.hooks.get(hookName).push({ handler, pluginName });
    this.logger.debug(`Hook registered: ${hookName} by ${pluginName}`);
  }

  unregisterHook(hookName, pluginName) {
    const hooks = this.hooks.get(hookName);
    if (!hooks) return;

    const index = hooks.findIndex(h => h.pluginName === pluginName);
    if (index > -1) hooks.splice(index, 1);
  }

  async executeHook(hookName, data = {}) {
    const hooks = this.hooks.get(hookName) || [];
    const results = [];

    for (const { handler, pluginName } of hooks) {
      try {
        const result = await handler(data);
        results.push({ pluginName, result });
      } catch (error) {
        this.logger.error(`Hook ${hookName} failed in ${pluginName}`, { error: error.message });
        results.push({ pluginName, error: error.message });
      }
    }

    return results;
  }

  async executeHookSync(hookName, data = {}) {
    const hooks = this.hooks.get(hookName) || [];

    for (const { handler, pluginName } of hooks) {
      try {
        data = await handler(data);
      } catch (error) {
        this.logger.error(`Hook ${hookName} failed in ${pluginName}`, { error: error.message });
      }
    }

    return data;
  }

  hasPlugin(name) {
    return this.plugins.has(name);
  }

  isEnabled(name) {
    return this.enabledPlugins.has(name);
  }

  async shutdown() {
    for (const [name, entry] of this.plugins) {
      if (typeof instance.shutdown === 'function') {
        try {
          await instance.shutdown();
        } catch (error) {
          this.logger.error(`Error shutting down plugin ${name}`, { error: error.message });
        }
      }
    }

    this.plugins.clear();
    this.hooks.clear();
    this.enabledPlugins.clear();
    this.emit('shutdown');
  }
}

export class BasePlugin {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.config = options.config || {};
    this.manager = null;
  }

  async initialize(manager) {
    this.manager = manager;
  }

  async enable() {}

  async disable() {}

  async shutdown() {}

  registerHook(hookName, handler) {
    this.manager?.registerHook(hookName, handler, this.constructor.name);
  }
}

export function createPlugin(name, definition) {
  class DynamicPlugin extends BasePlugin {
    constructor(options) {
      super(options);
      this.name = name;
    }

    async initialize(manager) {
      await super.initialize(manager);
      if (definition.initialize) {
        await definition.initialize.call(this, manager);
      }
    }

    async enable() {
      if (definition.enable) await definition.enable.call(this);
    }

    async disable() {
      if (definition.disable) await definition.disable.call(this);
    }

    async shutdown() {
      if (definition.shutdown) await definition.shutdown.call(this);
    }
  }

  return DynamicPlugin;
}

export default { PluginManager, BasePlugin, createPlugin };