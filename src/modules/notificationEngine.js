import { EventEmitter } from 'events';

export class NotificationEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.channels = new Map();
    this.templates = new Map();
    this.queue = [];
    this.processing = false;
    this.retryAttempts = this.config.retryAttempts || 3;
    this.retryDelay = this.config.retryDelay || 5000;
  }

  registerChannel(name, channel) {
    this.channels.set(name, {
      ...channel,
      name,
      enabled: channel.enabled !== false
    });
    this.logger.info(`Notification channel registered: ${name}`);
  }

  unregisterChannel(name) {
    return this.channels.delete(name);
  }

  getChannel(name) {
    return this.channels.get(name);
  }

  setTemplate(name, template) {
    this.templates.set(name, template);
  }

  getTemplate(name) {
    return this.templates.get(name);
  }

  async send(notification) {
    const { channels = ['default'], template, data = {}, priority = 'normal', ...options } = notification;

    let message = notification.message;
    if (template && this.templates.has(template)) {
      message = this.renderTemplate(this.templates.get(template), data);
    }

    const results = [];

    for (const channelName of channels) {
      const channel = this.channels.get(channelName);
      if (!channel || !channel.enabled) {
        results.push({ channel: channelName, success: false, reason: 'channel-not-found' });
        continue;
      }

      try {
        const result = await this.sendToChannel(channel, message, data, options);
        results.push({ channel: channelName, success: true, result });
      } catch (error) {
        this.logger.error(`Notification failed for ${channelName}`, { error: error.message });
        results.push({ channel: channelName, success: false, error: error.message });

        if (channel.retry) {
          this.scheduleRetry(channelName, notification, error);
        }
      }
    }

    this.emit('sent', { notification, results });
    return results;
  }

  async sendToChannel(channel, message, data, options) {
    switch (channel.type) {
      case 'webhook':
        return this.sendWebhook(channel, message, data);
      case 'email':
        return this.sendEmail(channel, message, data);
      case 'slack':
        return this.sendSlack(channel, message, data);
      case 'discord':
        return this.sendDiscord(channel, message, data);
      case 'desktop':
        return this.sendDesktop(channel, message, data);
      case 'console':
        return this.sendConsole(channel, message, data);
      case 'custom':
        return channel.handler(message, data, options);
      default:
        throw new Error(`Unknown channel type: ${channel.type}`);
    }
  }

  async sendWebhook(channel, message, data) {
    const payload = {
      message,
      data,
      timestamp: new Date().toISOString()
    };

    const response = await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...channel.headers },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
    }

    return { status: response.status };
  }

  async sendEmail(channel, message, data) {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport(channel.transport);

    const mailOptions = {
      from: channel.from,
      to: channel.to,
      subject: channel.subject || 'AI Orchestrator Notification',
      text: message,
      html: channel.htmlTemplate ? this.renderTemplate(channel.htmlTemplate, data) : undefined
    };

    return transporter.sendMail(mailOptions);
  }

  async sendSlack(channel, message, data) {
    const payload = {
      text: message,
      blocks: channel.blocks ? this.renderTemplate(channel.blocks, data) : undefined,
      attachments: channel.attachments
    };

    const response = await fetch(channel.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status}`);
    }

    return { status: response.status };
  }

  async sendDiscord(channel, message, data) {
    const payload = {
      content: message,
      embeds: channel.embeds ? [this.renderTemplate(channel.embeds, data)] : undefined,
      username: channel.username || 'AI Orchestrator'
    };

    const response = await fetch(channel.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Discord webhook failed: ${response.status}`);
    }

    return { status: response.status };
  }

  async sendDesktop(channel, message, data) {
    const notifier = await import('node-notifier');
    return new Promise((resolve, reject) => {
      notifier.notify({
        title: channel.title || 'AI Orchestrator',
        message,
        icon: channel.icon,
        sound: channel.sound,
        wait: channel.wait || false
      }, (err, response) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
  }

  async sendConsole(channel, message, data) {
    const prefix = channel.prefix || '[NOTIFICATION]';
    console.log(`${prefix} ${message}`);
    return { printed: true };
  }

  renderTemplate(template, data) {
    if (typeof template === 'string') {
      return template.replace(/\{\{(\w+)\}\}/g, (match, key) => data[key] || match);
    }
    if (typeof template === 'function') {
      return template(data);
    }
    if (typeof template === 'object') {
      const result = JSON.parse(JSON.stringify(template));
      return this.replaceInObject(result, data);
    }
    return template;
  }

  replaceInObject(obj, data) {
    if (typeof obj === null) return obj;
    if (typeof obj === 'string') return this.renderTemplate(obj, data);
    if (Array.isArray(obj)) return obj.map(item => this.replaceInObject(item, data));

    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.replaceInObject(value, data);
    }
    return result;
  }

  scheduleRetry(channelName, notification, error) {
    let attempts = notification.retryCount || 0;
    if (attempts >= this.retryAttempts) {
      this.logger.warn(`Max retry attempts reached for ${channelName}`);
      return;
    }

    setTimeout(() => {
      notification.retryCount = attempts + 1;
      this.send(notification).catch(err => {
        this.logger.error(`Retry failed for ${channelName}`, { error: err.message });
      });
    }, this.retryDelay * (attempts + 1));
  }

  async notify(event, data = {}) {
    const notifications = this.config.events?.[event];
    if (!notifications) return [];

    const results = [];
    for (const notif of notifications) {
      const result = await this.send({ ...notif, data: { ...data, ...notif.data } });
      results.push({ event, notification: notif, result });
    }

    return results;
  }

  getStats() {
    return {
      channels: Array.from(this.channels.keys()),
      templates: Array.from(this.templates.keys()),
      queueLength: this.queue.length
    };
  }
}

export function createDefaultNotifications(config) {
  const engine = new NotificationEngine({ config, logger: console });

  if (config.notifications?.webhook) {
    engine.registerChannel('webhook', {
      type: 'webhook',
      url: config.notifications.webhook,
      headers: config.notifications.webhookHeaders
    });
  }

  if (config.notifications?.email?.enabled) {
    engine.registerChannel('email', {
      type: 'email',
      transport: config.notifications.email,
      from: config.notifications.email.from,
      to: config.notifications.email.to
    });
  }

  if (config.notifications?.slack?.enabled) {
    engine.registerChannel('slack', {
      type: 'slack',
      webhookUrl: config.notifications.slack.webhook
    });
  }

  if (config.notifications?.discord?.enabled) {
    engine.registerChannel('discord', {
      type: 'discord',
      webhookUrl: config.notifications.discord.webhook
    });
  }

  engine.registerChannel('console', { type: 'console', prefix: '[AI-ORCHESTRATOR]' });

  engine.setTemplate('task-complete', 'Task {{taskName}} completed successfully');
  engine.setTemplate('task-failed', 'Task {{taskName}} failed: {{error}}');
  engine.setTemplate('session-complete', 'Session {{sessionName}} completed');
  engine.setTemplate('rate-limit', 'Rate limit reached for {{driver}}. Waiting {{waitTime}}ms');
  engine.setTemplate('crash', 'Driver {{driver}} crashed: {{error}}');

  return engine;
}

export default NotificationEngine;