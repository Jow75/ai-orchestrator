import schedule from 'node-schedule';

export class SystemScheduler {
  constructor(options = {}) {
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.jobs = new Map();
    this.recurringJobs = new Map();
    this.timezone = this.config.timezone || 'UTC';
  }

  /**
   * Schedule a job using cron syntax
   * @param {string} name - Unique name for the job
   * @param {string} cronExpression - Cron expression (e.g., '0 * * * *' for hourly)
   * @param {Function} task - Async function to execute
   * @param {Object} options - Additional options
   * @returns {Object} Job object
   */
  scheduleJob(name, cronExpression, task, options = {}) {
    if (this.jobs.has(name)) {
      throw new Error(`Job ${name} already exists`);
    }

    try {
      const job = schedule.scheduleJob(cronExpression, async () => {
        this.logger.debug(`Executing scheduled job: ${name}`);
        try {
          await task();
          this.logger.info(`Job ${name} completed successfully`);
        } catch (error) {
          this.logger.error(`Job ${name} failed:`, { error: error.message });
          if (options.onError) {
            options.onError(error);
          }
        }
      }, {
        tz: this.timezone
      });

      if (!job) {
        throw new Error(`Invalid cron expression: ${cronExpression}`);
      }

      this.jobs.set(name, {
        job,
        cronExpression,
        task,
        options,
        createdAt: new Date(),
        lastRun: null,
        nextInvocation: job.nextInvocation()
      });

      return {
        id: name,
        type: 'scheduled',
        cronExpression,
        nextInvocation: job.nextInvocation(),
        cancel: () => this.cancelJob(name)
      };
    } catch (error) {
      this.logger.error(`Failed to schedule job ${name}:`, { error: error.message });
      throw error;
    }
  }

  /**
   * Schedule a recurring job with interval in milliseconds
   * @param {string} name - Unique name for the job
   * @param {number} intervalMs - Interval in milliseconds
   * @param {Function} task - Async function to execute
   * @param {Object} options - Additional options
   * @returns {Object} Job object
   */
  scheduleInterval(name, intervalMs, task, options = {}) {
    if (this.recurringJobs.has(name)) {
      throw new Error(`Recurring job ${name} already exists`);
    }

    if (intervalMs <= 0) {
      throw new Error('Interval must be greater than 0');
    }

    let timer;
    let isRunning = false;

    const executeTask = async () => {
      if (isRunning) {
        this.logger.warn(`Job ${name} is still running, skipping this iteration`);
        return;
      }

      isRunning = true;
      const startTime = Date.now();
      this.logger.debug(`Executing interval job: ${name}`);

      try {
        await task();
        const duration = Date.now() - startTime;
        this.logger.info(`Job ${name} completed in ${duration}ms`);
        this.recurringJobs.get(name).lastRun = new Date();
      } catch (error) {
        this.logger.error(`Job ${name} failed:`, { error: error.message });
        if (options.onError) {
          options.onError(error);
        }
      } finally {
        isRunning = false;
      }
    };

    // Start immediately if requested
    if (options.runImmediately) {
      executeTask().catch(err => this.logger.error('Initial execution failed:', err));
    }

    timer = setInterval(executeTask, intervalMs);

    this.recurringJobs.set(name, {
      timer,
      intervalMs,
      task,
      options,
      createdAt: new Date(),
      lastRun: options.runImmediately ? new Date() : null
    });

    return {
      id: name,
      type: 'interval',
      intervalMs,
      nextInvocation: Date.now() + intervalMs,
      cancel: () => this.cancelJob(name)
    };
  }

  /**
   * Schedule a one-time job to run at a specific time
   * @param {string} name - Unique name for the job
   * @param {Date|string|number} runAt - When to run the job
   * @param {Function} task - Async function to execute
   * @param {Object} options - Additional options
   * @returns {Object} Job object
   */
  scheduleOnce(name, runAt, task, options = {}) {
    if (this.jobs.has(name)) {
      throw new Error(`Job ${name} already exists`);
    }

    const date = runAt instanceof Date ? runAt : new Date(runAt);
    const now = Date.now();

    if (date <= now) {
      throw new Error('Scheduled time must be in the future');
    }

    const delay = date.getTime() - now;
    const timeoutId = setTimeout(async () => {
      this.logger.debug(`Executing one-time job: ${name}`);
      try {
        await task();
        this.logger.info(`Job ${name} completed successfully`);
      } catch (error) {
        this.logger.error(`Job ${name} failed:`, { error: error.message });
        if (options.onError) {
          options.onError(error);
        }
      } finally {
        this.jobs.delete(name);
      }
    }, delay);

    this.jobs.set(name, {
      timeoutId,
      runAt: date,
      task,
      options,
      createdAt: new Date()
    });

    return {
      id: name,
      type: 'once',
      runAt: date,
      cancel: () => this.cancelJob(name)
    };
  }

  /**
   * Cancel a scheduled job
   * @param {string} name - Name of the job to cancel
   * @returns {boolean} True if job was cancelled, false if not found
   */
  cancelJob(name) {
    // Check scheduled jobs
    const job = this.jobs.get(name);
    if (job) {
      if (job.job) {
        job.job.cancel();
      } else if (job.timeoutId) {
        clearTimeout(job.timeoutId);
      }
      this.jobs.delete(name);
      this.logger.info(`Job ${name} cancelled`);
      return true;
    }

    // Check recurring jobs
    const recurringJob = this.recurringJobs.get(name);
    if (recurringJob) {
      clearInterval(recurringJob.timer);
      this.recurringJobs.delete(name);
      this.logger.info(`Recurring job ${name} cancelled`);
      return true;
    }

    return false;
  }

  /**
   * Cancel all jobs
   */
  cancelAllJobs() {
    for (const name of this.jobs.keys()) {
      this.cancelJob(name);
    }
    for (const name of this.recurringJobs.keys()) {
      this.cancelJob(name);
    }
    this.logger.info('All jobs cancelled');
  }

  /**
   * Get information about a specific job
   * @param {string} name - Name of the job
   * @returns {Object|null} Job information or null if not found
   */
  getJob(name) {
    const job = this.jobs.get(name);
    if (job) {
      return {
        id: name,
        type: 'scheduled',
        cronExpression: job.cronExpression,
        createdAt: job.createdAt,
        lastRun: job.lastRun,
        nextInvocation: job.nextInvocation,
        cancel: () => this.cancelJob(name)
      };
    }

    const recurringJob = this.recurringJobs.get(name);
    if (recurringJob) {
      return {
        id: name,
        type: 'interval',
        intervalMs: recurringJob.intervalMs,
        createdAt: recurringJob.createdAt,
        lastRun: recurringJob.lastRun,
        nextInvocation: Date.now() + recurringJob.intervalMs,
        cancel: () => this.cancelJob(name)
      };
    }

    const onceJob = this.jobs.get(name);
    if (onceJob && onceJob.timeoutId) {
      return {
        id: name,
        type: 'once',
        runAt: onceJob.runAt,
        createdAt: onceJob.createdAt,
        cancel: () => this.cancelJob(name)
      };
    }

    return null;
  }

  /**
   * Get all scheduled jobs
   * @returns {Object} Object containing all jobs by type
   */
  getAllJobs() {
    const scheduled = [];
    const recurring = [];
    const once = [];

    for (const [name, job] of this.jobs) {
      if (job.timeoutId) {
        once.push({
          id: name,
          type: 'once',
          runAt: job.runAt,
          createdAt: job.createdAt
        });
      } else {
        scheduled.push({
          id: name,
          type: 'scheduled',
          cronExpression: job.cronExpression,
          createdAt: job.createdAt,
          lastRun: job.lastRun,
          nextInvocation: job.nextInvocation
        });
      }
    }

    for (const [name, job] of this.recurringJobs) {
      recurring.push({
        id: name,
        type: 'interval',
        intervalMs: job.intervalMs,
        createdAt: job.createdAt,
        lastRun: job.lastRun,
        nextInvocation: Date.now() + job.intervalMs
      });
    }

    return { scheduled, recurring, once };
  }

  /**
   * Get job statistics
   * @returns {Object} Statistics about jobs
   */
  getJobStats() {
    let totalExecutions = 0;
    let successfulExecutions = 0;
    let failedExecutions = 0;

    // This would require tracking execution history in a real implementation
    // For now, we'll return basic counts
    return {
      scheduledJobs: this.jobs.size,
      recurringJobs: this.recurringJobs.size,
      totalJobs: this.jobs.size + this.recurringJobs.size,
      nextExecution: this.getNextExecution()
    };
  }

  /**
   * Get the time until the next job execution
   * @returns {number|null} Milliseconds until next execution, or null if no jobs
   */
  getNextExecution() {
    let nextTime = Infinity;

    // Check scheduled jobs
    for (const job of this.jobs.values()) {
      if (job.nextInvocation && job.nextInvocation.getTime() < nextTime) {
        nextTime = job.nextInvocation.getTime();
      }
    }

    // Check recurring jobs
    for (const job of this.recurringJobs.values()) {
      const next = Date.now() + job.intervalMs;
      if (next < nextTime) {
        nextTime = next;
      }
    }

    // Check one-time jobs
    for (const job of this.jobs.values()) {
      if (job.timeoutId && job.runAt.getTime() < nextTime) {
        nextTime = job.runAt.getTime();
      }
    }

    return nextTime === Infinity ? null : nextTime - Date.now();
  }

  /**
   * Shutdown the scheduler and cancel all jobs
   */
  shutdown() {
    this.cancelAllJobs();
    this.logger.info('Scheduler shutdown');
  }
}

export default SystemScheduler;