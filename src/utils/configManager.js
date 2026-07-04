import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import Logger from './logger.js';

class ConfigManager {
  constructor(options = {}) {
    this.logger = options.logger || new Logger();
    this.config = {};
    this.configPath = options.configPath || './config';
    this.environment = options.environment || process.env.NODE_ENV || 'development';
    this.loaded = false;
  }

  load() {
    if (this.loaded) {
      return this.config;
    }

    const defaultPath = path.join(this.configPath, 'default.yaml');
    const envPath = path.join(this.configPath, `${this.environment}.yaml`);
    const localPath = path.join(this.configPath, 'local.yaml');

    this.config = this.loadFile(defaultPath);

    if (fs.existsSync(envPath)) {
      const envConfig = this.loadFile(envPath);
      this.config = this.deepMerge(this.config, envConfig);
    }

    if (fs.existsSync(localPath)) {
      const localConfig = this.loadFile(localPath);
      this.config = this.deepMerge(this.config, localConfig);
    }

    this.applyEnvOverrides();
    this.validate();
    this.loaded = true;

    this.logger.info('Configuration loaded', {
      environment: this.environment,
      configPath: this.configPath
    });

    return this.config;
  }

  loadFile(filePath) {
    if (!fs.existsSync(filePath)) {
      this.logger.warn(`Config file not found: ${filePath}`);
      return {};
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return yaml.load(content) || {};
    } catch (error) {
      this.logger.error(`Failed to load config file: ${filePath}`, { error: error.message });
      throw error;
    }
  }

  deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  applyEnvOverrides() {
    const envPrefix = 'AI_ORCHESTRATOR_';
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(envPrefix)) {
        const configKey = key.slice(envPrefix.length).toLowerCase().replace(/_/g, '.');
        this.set(configKey, this.parseValue(value));
      }
    }
  }

  parseValue(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d*\.\d+$/.test(value)) return parseFloat(value);
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  validate() {
    const required = ['app.name', 'app.version', 'server.port'];
    for (const key of required) {
      if (!this.get(key)) {
        this.logger.warn(`Required config missing: ${key}`);
      }
    }
  }

  get(key, defaultValue = undefined) {
    if (!this.loaded) this.load();
    const keys = key.split('.');
    let value = this.config;
    for (const k of keys) {
      if (value === undefined || value === null) return defaultValue;
      value = value[k];
    }
    return value !== undefined ? value : defaultValue;
  }

  set(key, value) {
    if (!this.loaded) this.load();
    const keys = key.split('.');
    let obj = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  getAll() {
    if (!this.loaded) this.load();
    return { ...this.config };
  }

  getEnvironment() {
    return this.environment;
  }

  reload() {
    this.loaded = false;
    return this.load();
  }

  save(filePath = null) {
    const targetPath = filePath || path.join(this.configPath, `${this.environment}.yaml`);
    const content = yaml.dump(this.config, { indent: 2 });
    fs.writeFileSync(targetPath, content, 'utf8');
    this.logger.info(`Configuration saved to ${targetPath}`);
  }
}

export default ConfigManager;