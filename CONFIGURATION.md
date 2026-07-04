# Configuration Guide

AI-Orchestrator uses a hierarchical configuration system that allows settings to be defined at multiple levels and overridden as needed.

## Configuration Sources

Configuration is loaded from the following sources, in order of precedence (later sources override earlier ones):

1. **Default Configuration** (`config/default.yaml`) - Base defaults
2. **Environment Configuration** (`config/{environment}.yaml`) - Environment-specific overrides
3. **Local Configuration** (`config/local.yaml`) - Local overrides (not version controlled)
4. **Environment Variables** - `APP_*` prefixed variables
5. **Runtime Overrides** - Programmatic API changes

## Configuration Files

### Default Configuration (`config/default.yaml`)
Contains all available configuration options with their default values. This file should not be modified directly as it may be overwritten during updates.

### Environment Configuration
- `config/development.yaml` - Used when NODE_ENV=development (default)
- `config/production.yaml` - Used when NODE_ENV=production
- `config/staging.yaml` - Used when NODE_ENV=staging

Create additional environment files as needed (e.g., `config/test.yaml`).

### Local Configuration (`config/local.yaml`)
For machine-specific settings and secrets that should not be committed to version control. This file is ignored by git.

## Configuration Structure

The configuration is organized into logical sections:

```yaml
app:
  # Application metadata
  name: "ai-orchestrator"
  version: "1.0.0"
  environment: "development"
  logLevel: "info"

server:
  # HTTP/WebSocket server settings
  host: "127.0.0.1"
  port: 3000
  wsPort: 3001
  cors:
    origin: "*"
    credentials: true

orchestrator:
  # Core orchestrator behavior
  maxConcurrentAgents: 10
  defaultTimeout: 300000
  retryAttempts: 3
  retryDelay: 5000
  heartbeatInterval: 30000
  taskQueueSize: 1000
  agentPoolSize: 5
  healthCheckInterval: 60000

agents:
  # Global agent settings
  defaultTimeout: 120000
  maxRetries: 3
  healthCheckInterval: 30000
  restartOnFailure: true
  maxRestarts: 3
  types:
    - "orchestrator"
    - "worker"
    - "researcher"
    - "coder"
    - "reviewer"
    - "tester"
    - "deployer"

  # Agent-type specific configurations
  orchestrator:
    maxConcurrent: 3
    priority: 10
    capabilities:
      - "task-planning"
      - "task-delegation"
      - "progress-tracking"
      - "result-aggregation"
  
  worker:
    maxConcurrent: 10
    priority: 5
    capabilities:
      - "code-generation"
      - "file-operations"
      - "command-execution"
  
  # ... similar sections for other agent types

logging:
  # Logging configuration
  level: "info"
  format: "json"
  directory: "./logs"
  maxFiles: 10
  maxSize: "10m"
  console: true
  file: true
  rotation: "daily"

database:
  # Database configuration
  type: "sqlite"
  path: "./data/orchestrator.db"
  migrations: "./migrations"

cache:
  # Caching configuration
  type: "memory"
  ttl: 3600
  maxKeys: 10000

queue:
  # Queue configuration
  type: "memory"
  redis:
    host: "127.0.0.1"
    port: 6379
    password: ""
    db: 0

monitoring:
  # Monitoring and metrics
  enabled: true
  metricsPort: 9090
  healthCheckPath: "/health"
  metricsPath: "/metrics"

security:
  # Security settings
  apiKey: ""
  jwtSecret: ""
  rateLimit:
    windowMs: 900000
    maxRequests: 100

notifications:
  # Notification system configuration
  enabled: false
  webhook: ""
  email:
    enabled: false
    host: ""
    port: 587
    user: ""
    pass: ""
    from: ""
  slack:
    enabled: false
    webhook: ""
  discord:
    enabled: false
    webhook: ""

agentManager:
  # Agent Manager (worktree) configuration
  enabled: true
  worktreePath: "./worktrees"
  maxWorktrees: 10
  autoCleanup: true
  cleanupInterval: 3600000
  defaultBranch: "main"
  remoteName: "origin"
```

## Environment Variables

Environment variables follow the pattern `APP_SECTION_SUBSECTION_KEY` and are converted to lowercase with underscores replaced with environment variables:
- `APP_SERVER_PORT=8080` → sets `server.port` to 8080
- `APP_LOGGING_LEVEL=debug` → sets `logging.level` to "debug"
- `APP_NOTIFICATIONS_WEBHOOK_URL=https://example.com/webhook` → sets `notifications.webhook.url`

Special environment variables:
- `NODE_ENV`: Determines which environment config to load (development, production, etc.)
- `PORT`: Alternative way to set server.port (for PaaS providers like Heroku)

## Configuration Validation

The system validates required configuration values on startup. Missing required settings will cause the application to fail to start with a clear error message.

Required configuration sections:
- `app.name`
- `app.version`
- `server.port`

## Runtime Configuration Changes

Configuration can be modified at runtime through the API:

```javascript
// Via Node.js API
const config = require('./src/utils/configManager');

// Get a value
const port = config.get('server.port');

// Set a value
config.set('server.port', 3001);

// Get the entire configuration
const allConfig = config.getAll();

// Reload from files
config.reload();
```

## Environment-Specific Examples

### Development (`config/development.yaml`)
```yaml
app:
  environment: "development"
  logLevel: "debug"

server:
  host: "127.0.0.1"
  port: 3000

logging:
  level: "debug"
  format: "pretty"
  console: true
  file: true

notifications:
  enabled: false

agentManager:
  enabled: true
  worktreePath: "./worktrees"
```

### Production (`config/production.yaml`)
```yaml
app:
  environment: "production"
  logLevel: "warn"

server:
  host: "0.0.0.0"
  port: 3000

logging:
  level: "warn"
  format: "json"
  console: false
  file: true
  maxFiles: 30
  maxSize: "50m"

notifications:
  enabled: true
  webhook: "${WEBHOOK_URL}"
  email:
    enabled: true
    host: "${SMTP_HOST}"
    port: 587
    user: "${SMTP_USER}"
    pass: "${SMTP_PASS}"
    from: "${SMTP_FROM}"
  slack:
    enabled: true
    webhook: "${SLACK_WEBHOOK}"
  discord:
    enabled: true
    webhook: "${DISCORD_WEBHOOK}"

agentManager:
  enabled: true
  worktreePath: "/var/worktrees/ai-orchestrator"
  maxWorktrees: 50
  autoCleanup: true
  cleanupInterval: 86400000
```

## Best Practices

### Security
1. Never commit secrets to version control
2. Use `config/local.yaml` or environment variables for sensitive data
3. Use strong, randomly generated values for `jwtSecret` and API keys
4. Restrict CORS origins in production
5. Use HTTPS in production deployments

### Performance
1. Adjust `agentPoolSize` based on your workload and available resources
2. Tune `healthCheckInterval` based on your monitoring needs
3. Configure appropriate `timeout` values for your typical operations
4. Monitor memory usage and adjust cache sizes accordingly

### High Availability
1. Enable clustering for multiple instances
2. Use shared storage (database, Redis) for session state
3. Implement load balancing behind a reverse proxy
4. Set up health checks and automated failover

## Configuration Reference

### App Settings
- `app.name`: Application name (string)
- `app.version`: Application version (string)
- `app.environment`: Environment name (string)
- `app.logLevel`: Default log level (string: trace, debug, info, warn, error)

### Server Settings
- `server.host`: Host to bind to (string)
- `server.port`: HTTP port (number)
- `server.wsPort`: WebSocket port (number)
- `server.cors.origin`: CORS allowed origins (string or array)
- `server.cors.credentials`: Allow credentials in CORS requests (boolean)

### Orchestrator Settings
- `orchestrator.maxConcurrentAgents`: Maximum simultaneous agents (number)
- `orchestrator.defaultTimeout`: Default task timeout in ms (number)
- `orchestrator.retryAttempts`: Number of retry attempts (number)
- `orchestrator.retryDelay`: Delay between retries in ms (number)
- `orchestrator.heartbeatInterval`: Agent heartbeat interval in ms (number)
- `orchestrator.taskQueueSize`: Maximum queued tasks (number)
- `orchestrator.agentPoolSize`: Default pool size per agent type (number)
- `orchestrator.healthCheckInterval`: Health check interval in ms (number)

### Agent Settings
- `agents.defaultTimeout`: Default timeout for agent operations (number)
- `agents.maxRetries`: Maximum retry attempts for agent failures (number)
- `agents.healthCheckInterval`: Health check interval for agents (number)
- `agents.restartOnFailure`: Whether to restart failed agents (boolean)
- `agents.maxRestarts`: Maximum restart attempts before giving up (number)
- `agents.types`: List of agent types to load (array of strings)

### Logging Settings
- `logging.level`: Log level (string: trace, debug, info, warn, error)
- `logging.format`: Log format (string: json, pretty)
- `logging.directory`: Log directory path (string)
- `logging.maxFiles`: Maximum number of log files to retain (number)
- `logging.maxSize`: Maximum size per log file (string with unit: e.g., "10m", "100mb")
- `logging.console`: Enable console output (boolean)
- `logging.file`: Enable file output (boolean)
- `logging.rotation`: Rotation schedule (string: hourly, daily, weekly, monthly)

### Database Settings
- `database.type`: Database type (string: sqlite, postgresql, mysql)
- `database.path`: For SQLite, file path; for others, connection string or host
- `database.host`: Database host (string)
- `database.port`: Database port (number)
- `database.database`: Database name (string)
- `database.username`: Database username (string)
- `database.password`: Database password (string)
- `database.pool.min`: Minimum connection pool size (number)
- `database.pool.max`: Maximum connection pool size (number)
- `database.migrations`: Path to migration files (string)

### Cache Settings
- `cache.type`: Cache type (string: memory, redis)
- `cache.ttl`: Default time-to-live in seconds (number)
- `cache.maxKeys`: Maximum number of keys to store (number)
- `cache.redis.host`: Redis host (string)
- `cache.redis.port`: Redis port (number)
- `cache.redis.password`: Redis password (string)
- `cache.redis.db`: Redis database number (number)

### Queue Settings
- `queue.type`: Queue type (string: memory, redis)
- `queue.redis.host`: Redis host (string)
- `queue.redis.port`: Redis port (number)
- `queue.redis.password`: Redis password (string)
- `queue.redis.db`: Redis database number (number)

### Monitoring Settings
- `monitoring.enabled`: Enable monitoring endpoints (boolean)
- `monitoring.metricsPort`: Port for metrics endpoint (number)
- `monitoring.healthCheckPath`: Path for health check endpoint (string)
- `monitoring.metricsPath`: Path for metrics endpoint (string)

### Security Settings
- `security.apiKey`: API key for authentication (string)
- `security.jwtSecret`: Secret for JWT token signing (string)
- `security.rateLimit.windowMs`: Rate limit window in milliseconds (number)
- `security.rateLimit.maxRequests`: Maximum requests per window (number)

### Notification Settings
- `notifications.enabled`: Enable notification system (boolean)
- `notifications.webhook`: Default webhook URL (string)
- `notifications.email.enabled`: Enable email notifications (boolean)
- `notifications.email.host`: SMTP host (string)
- `notifications.email.port`: SMTP port (number)
- `notifications.email.user`: SMTP username (string)
- `notifications.email.pass`: SMTP password (string)
- `notifications.email.from`: From email address (string)
- `notifications.slack.enabled`: Enable Slack notifications (boolean)
- `notifications.slack.webhook`: Slack webhook URL (string)
- `notifications.discord.enabled`: Enable Discord notifications (boolean)
- `notifications.discord.webhook`: Discord webhook URL (string)

### Agent Manager Settings
- `agentManager.enabled`: Enable Agent Manager (worktree) functionality (boolean)
- `agentManager.worktreePath`: Base directory for worktrees (string)
- `agentManager.maxWorktrees`: Maximum number of worktrees (number)
- `agentManager.autoCleanup`: Automatically clean up old worktrees (boolean)
- `agentManager.cleanupInterval`: Cleanup interval in milliseconds (number)
- `agentManager.defaultBranch`: Default branch for new worktrees (string)
- `agentManager.remoteName`: Git remote name (string)

## Override Examples

### Changing the Port
```yaml
# In config/development.yaml or config/production.yaml
server:
  port: 8080
```

### Enabling Debug Logging
```yaml
# In config/development.yaml
logging:
  level: "debug"
  format: "pretty"
```

### Configuring Email Notifications
```yaml
# In config/production.yaml or config/local.yaml
notifications:
  enabled: true
  email:
    enabled: true
    host: "smtp.gmail.com"
    port: 587
    user: "your_email@gmail.com"
    pass: "your_app_password"
    from: "noreply@yourdomain.com"
```

### Using Environment Variables
```bash
# Set environment variables
export APP_SERVER_PORT=8080
export APP_LOGGING_LEVEL=debug
export APP_NOTIFICATIONS_EMAIL_HOST=smtp.gmail.com
export APP_NOTIFICATIONS_EMAIL_USER=your_email@gmail.com
export APP_NOTIFICATIONS_EMAIL_PASS=your_app_password

# Or in .env file
SERVER_PORT=8080
LOGGING_LEVEL=debug
NOTIFICATIONS_EMAIL_HOST=smtp.gmail.com
NOTIFICATIONS_EMAIL_USER=your_email@gmail.com
NOTIFICATIONS_EMAIL_PASS=your_app_password
```