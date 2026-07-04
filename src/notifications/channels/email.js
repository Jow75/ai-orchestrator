/**
 * channels/email.js — Email channel (architecture placeholder).
 *
 * Email delivery needs an SMTP dependency and per-provider configuration
 * that this project has deliberately not taken on yet (see ROADMAP.md).
 * The channel exists so enabling it is a config change when it lands —
 * until then it reports clearly instead of failing silently.
 *
 * Tip: the webhook channel is the practical stand-in today (point it at an
 * email-bridge service such as ntfy.sh with email forwarding).
 */

export class EmailChannel {
  constructor({ config, logger }) {
    this.name = 'email';
    this.config = config;
    this.logger = logger;
    this.warned = false;
  }

  async send() {
    if (!this.warned) {
      this.warned = true; // one clear warning, not one per event
      this.logger.warn(
        'Email notifications are not implemented yet (see ROADMAP.md). ' +
        'Use the webhook, discord, or telegram channel in the meantime.'
      );
    }
  }
}

export default EmailChannel;
