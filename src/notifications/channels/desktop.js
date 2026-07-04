/**
 * channels/desktop.js — Windows/macOS/Linux desktop toast notifications.
 * The only channel enabled by default: zero configuration, local-only.
 */

import notifier from 'node-notifier';

export class DesktopChannel {
  constructor({ logger }) {
    this.name = 'desktop';
    this.logger = logger;
  }

  /** @param {{title: string, message: string}} notification */
  async send({ title, message }) {
    return new Promise((resolve, reject) => {
      notifier.notify({ title, message, wait: false }, (error) =>
        error ? reject(error) : resolve()
      );
    });
  }
}

export default DesktopChannel;
