import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

class ConfigManager {
  constructor() {
    this.config = null;
    this.configPath = null;
  }

  load(configPath = null) {
    const env = process.env.NODE_ENV || 'development';
    const basePath = configPath || path.join(process.cwd(), 'config');

    const files = [
      path.join(basePath, 'default.yaml'),
      path.join(basePath, `${env}.yaml`),
      path.join(basePath, 'local.yaml')
    ];

    let mergedConfig = {};

    for (const file of files) {
      if (fs.existsSync(file)) {
        const fileConfig = yaml.load(fs.readFileSync(file, 'utf8'));
        mergedConfig = this.deepMerge(mergedConfig, fileConfig);
      }
    }

    this.config = this.resolveEnvVars(mergedConfig);
    this.configPath = basePath;
    return this.config;
  }

  get(key = null) {
    if (!this.config) {
      this.load();
    }
    if (!key) return this.config;
    return this.getNested(key);
  }

  getNested(key) {
    const keys = key.split('.');
    let value = this.config;
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return undefined;
      }
    }
    return value;
  }

  set(key, value) {
    if (!this.config) {
      this.load();
    }
    const keys = key.split('.');
    let obj = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
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

  resolveEnvVars(obj) {
    if (typeof obj === 'string') {
      return obj.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
        return process.env[envVar] || match;
      });
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.resolveEnvVars(item));
    }
    if (obj && typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.resolveEnvVars(value);
      }
      return result;
    }
    return obj;
  }

  reload() {
    return this.load(this.configPath);
  }

  validate() {
    const required = [
      'app.name',
      'app.version',
      'orchestrator.maxConcurrentAgents',
      'server.port'
    ];
    const missing = required.filter(key => !this.get(key));
    if (missing.length > 0) {
      throw new Error(`Missing required config: ${missing.join(', ')}`);
    }
    return true;
  }
}

export default new ConfigManager();