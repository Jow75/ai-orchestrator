/**
 * channels/email.js — Email channel (real SMTP delivery since Phase 10C).
 *
 * Long an architecture placeholder ("needs an SMTP dependency"), now backed
 * by the project's own dependency-free SMTP client (../smtpClient.js —
 * STARTTLS/implicit TLS, AUTH PLAIN/LOGIN). Configure under
 * `notifications.email`:
 *
 *   {
 *     "enabled": true,
 *     "smtp": { "host": "smtp.gmail.com", "port": 587, "starttls": true,
 *               "user": "me@gmail.com", "pass": "<app password>" },
 *     "from": "me@gmail.com",
 *     "to": "me@gmail.com"
 *   }
 */

import { sendMail } from '../smtpClient.js';

export class EmailChannel {
  /**
   * @param {object} options
   * @param {object} options.config - { smtp, from, to }.
   * @param {object} options.logger
   * @param {Function} [options.sendMailFn] - Injectable transport (tests).
   */
  constructor({ config, logger, sendMailFn }) {
    this.name = 'email';
    this.config = config;
    this.logger = logger;
    this.sendMailFn = sendMailFn ?? sendMail;
  }

  /** @param {{title: string, message: string}} notification */
  async send({ title, message }) {
    const { smtp, from, to } = this.config;
    if (!smtp?.host || !from || !to) {
      throw new Error('email channel enabled but "smtp.host"/"from"/"to" are not configured');
    }
    await this.sendMailFn({ ...smtp, from, to, subject: title, text: message });
  }
}

export default EmailChannel;
