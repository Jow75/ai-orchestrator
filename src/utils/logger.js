import winston from 'winston';
import path from 'path';
import fs from 'fs';

class Logger {
  constructor(config = {}) {
    this.config = {
      level: config.level || 'info',
      format: config.format || 'json',
      directory: config.directory || './logs',
      maxFiles: config.maxFiles || 10,
      maxSize: config.maxSize || '10m',
      console: config.console !== false,
      file: config.file !== false,
      rotation: config.rotation || 'daily'
    };

    this.logger = this.createLogger();
  }

  createLogger() {
    const transports = [];

    if (this.config.console) {
      transports.push(new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
            return `${timestamp} [${level}]: ${message} ${metaStr}`;
          })
        )
      }));
    }

    if (this.config.file) {
      if (!fs.existsSync(this.config.directory)) {
        fs.mkdirSync(this.config.directory, { recursive: true });
      }

      transports.push(new winston.transports.DailyRotateFile({
        filename: path.join(this.config.directory, 'application-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: this.config.maxFiles,
        maxSize: this.config.maxSize,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        ),
        zippedArchive: true
      }));

      transports.push(new winston.transports.DailyRotateFile({
        filename: path.join(this.config.directory, 'error-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: this.config.maxFiles,
        maxSize: this.config.maxSize,
        level: 'error',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        ),
        zippedArchive: true
      }));
    }

    return winston.createLogger({
      level: this.config.level,
      transports,
      exitOnError: false
    });
  }

  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  error(message, meta = {}) {
    this.logger.error(message, meta);
  }

  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }

  verbose(message, meta = {}) {
    this.logger.verbose(message, meta);
  }

  log(level, message, meta = {}) {
    this.logger.log(level, message, meta);
  }

  child(meta) {
    return this.logger.child(meta);
  }

  stream() {
    return {
      write: (message) => {
        this.info(message.trim());
      }
    };
  }
}

export default Logger;