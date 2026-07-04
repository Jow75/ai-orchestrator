/**
 * channels/webhook.js — Generic webhook channel.
 *
 * POSTs every notification as JSON to a user-configured URL. This is the
 * universal integration point: anything that can receive an HTTP POST
 * (Slack, ntfy, Home Assistant, custom services) can consume it.
 *
 * Payload shape:
 *   { "event": "session:rate-limited", "title": "...", "message": "...",
 *     "timestamp": "ISO-8601", "data": { ...event payload... } }
 */

/** Abort a hung webhook call after this long. */
const REQUEST_TIMEOUT_MS = 15_000;

export class WebhookChannel {
  constructor({ config, logger }) {
    this.name = 'webhook';
    this.config = config;
    this.logger = logger;
  }

  /** @param {{title: string, message: string, event: string, payload: object}} n */
  async send({ title, message, event, payload }) {
    if (!this.config.url) {
      throw new Error('webhook channel enabled but "url" is not configured');
    }

    const response = await fetch(this.config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.config.headers },
      body: JSON.stringify({
        event,
        title,
        message,
        timestamp: new Date().toISOString(),
        data: sanitizePayload(payload),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`webhook responded ${response.status}`);
    }
  }
}

/** Strip heavyweight fields; webhooks get facts, not transcripts. */
function sanitizePayload(payload = {}) {
  const { session, ...rest } = payload;
  return {
    ...rest,
    session: session
      ? {
          id: session.id,
          project: session.project,
          state: session.state,
          runs: session.runs,
          resumes: session.resumes,
          crashes: session.crashes,
          rateLimits: session.rateLimits,
        }
      : undefined,
  };
}

export default WebhookChannel;
