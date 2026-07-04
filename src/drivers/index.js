export { AIDriver, driverRegistry, DriverRegistry } from './base.js';
export { ClaudeDriver } from './claude.js';

import { driverRegistry } from './base.js';
import { ClaudeDriver } from './claude.js';

driverRegistry.register(new ClaudeDriver());

export function createDriver(type, options) {
  switch (type) {
    case 'claude':
      return new ClaudeDriver(options);
    default:
      throw new Error(`Unknown driver type: ${type}`);
  }
}

export function getAvailableDrivers() {
  return ['claude'];
}

export default {
  AIDriver,
  DriverRegistry,
  driverRegistry,
  ClaudeDriver,
  createDriver,
  getAvailableDrivers
};