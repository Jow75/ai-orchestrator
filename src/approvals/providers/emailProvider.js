/**
 * emailProvider.js — Phase 10C: publish-only email approval provider.
 *
 * Delivers approval requests by SMTP (see ../../notifications/smtpClient.js
 * — dependency-free, STARTTLS/TLS, AUTH). Email is one-way by design:
 * reading a mailbox would mean an IMAP/POP3 client and polling someone's
 * inbox, complexity this phase deliberately avoids. The published message
 * therefore tells the owner exactly how to respond — Telegram reply, CLI,
 * API, or the desktop Approvals view. `canReceive` stays false so the
 * Approval Manager never polls this provider for decisions.
 */

import { ApprovalProvider } from './approvalProvider.js';
import { sendMail } from '../../notifications/smtpClient.js';

export class EmailApprovalProvider extends ApprovalProvider {
  /**
   * @param {object} options
   * @param {object} options.config - { smtp: {host, port, ...}, from, to }.
   * @param {object} options.logger
   * @param {Function} [options.sendMailFn] - Injectable transport (tests).
   */
  constructor({ config, logger, sendMailFn }) {
    super({ config, logger });
    this.name = 'email';
    this.canReceive = false;
    this.sendMailFn = sendMailFn ?? sendMail;
  }

  /** @param {{request: object, title: string, message: string}} publication */
  async publish({ request, title, message }) {
    const { smtp, from, to } = this.config;
    if (!smtp?.host || !from || !to) {
      throw new Error('email approval provider needs "smtp.host", "from", and "to"');
    }
    await this.sendMailFn({
      ...smtp,
      from,
      to,
      subject: title,
      text:
        `${message}\n\n` +
        'Email replies are not monitored. Respond with:\n' +
        `  Telegram: APPROVE ${request.id} / REJECT ${request.id} / MODIFY ${request.id} <note>\n` +
        `  CLI:      ai-orchestrator approvals approve ${request.id}\n` +
        '  Desktop:  the Approvals view',
    });
  }
}

export default EmailApprovalProvider;
