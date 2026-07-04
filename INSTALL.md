# Installation Guide

## System Requirements

- Node.js >= 18.0.0
- npm >= 9.0.0
- Git (for version control)
- Claude Code CLI (for AI agent functionality)
- Supported Operating Systems:
  - Windows 10/11
  - macOS 10.15+
  - Ubuntu Linux 20.04+
  - Other Linux distributions with Node.js support

## Prerequisites Installation

### Node.js
Download and install Node.js from https://nodejs.org/ (choose LTS version)

Verify installation:
```bash
node --version
# Should output v18.x.x or higher

npm --version
# Should output 9.x.x or higher
```

### Claude Code CLI
Install Claude Code CLI according to Anthropic's documentation:
```bash
# Example installation method (adjust based on current official method)
npm install -g @anthropic-ai/claude-code
# Or follow instructions at: https://docs.anthropic.com/claude/docs/cli-setup
```

Verify installation:
```bash
claude --version
```

## Installation Steps

### 1. Clone the Repository
```bash
git clone https://github.com/your-org/ai-orchestrator.git
cd ai-orchestrator
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Create Configuration Files
Copy the default configuration to create environment-specific configs:
```bash
cp config/default.yaml config/development.yaml
cp config/default.yaml config/production.yaml
```

### 4. Configure Environment Variables (Optional)
Create a `.env` file in the root directory:
```bash
cp .env.example .env
# Edit .env to set your environment variables
```

Example `.env` file:
```
NODE_ENV=development
API_KEY=your_api_key_here
JWT_SECRET=your_jwt_secret_here
WEBHOOK_URL=https://your-webhook-endpoint.com
SLACK_WEBHOOK=https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
DISCORD_WEBHOOK=https://discord.com/api/webhooks/YOUR/DISCORD/WEBHOOK
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_email@example.com
SMTP_PASS=your_password
SMTP_FROM=ai-orchestrator@example.com
```

### 5. Verify Installation
Run the built-in diagnostic tool:
```bash
node src/index.js doctor
```

This will check:
- Node.js version
- Claude Code availability
- Configuration file validity
- Directory permissions
- Required dependencies

## Directory Structure

```
ai-orchestrator/
├── src/                    # Source code
│   ├── api/                # API and dashboard components
│   ├── cli/                # Command-line interface
│   ├── config/             # Configuration management
│   ├── core/               # Core orchestration logic
│   ├── drivers/            # AI agent drivers
│   ├── managers/           # Session and status management
│   ├── modules/            # Functional modules (recovery, scheduling, etc.)
│   ├── plugins/            # Plugin system
│   ├── utils/              # Utility functions
│   └── index.js            # Application entry point
├── config/                 # Configuration files
├── logs/                   # Log files (created automatically)
├── public/                 # Static files for dashboard
├── tests/                  # Test files
├── docs/                   # Documentation
├── package.json            # Project dependencies and scripts
└README.md                  # This file
```

## Configuration Files

### Default Configuration (`config/default.yaml`)
Contains default values for all settings. Do not modify this file directly.

### Environment Configuration (`config/development.yaml`, `config/production.yaml`)
Environment-specific overrides. These files are loaded based on the NODE_ENV variable.

### Local Configuration (`config/local.yaml`)
Local overrides that are not committed to version control. Use for secrets and machine-specific settings.

## Quick Start

### Development Mode
```bash
# Start in development mode with auto-reload
npm run dev
```

### Production Mode
```bash
# Start in production mode
npm start
```

### Using CLI Directly
```bash
# Start the orchestrator
node src/index.js start --env development

# Stop the orchestrator
node src/index.js stop

# Check status
node src/index.js status

# Run diagnostics
node src/index.js doctor
```

## Verification

After starting the system, verify it's working correctly:

1. Check that the API is responding:
   ```bash
   curl http://localhost:3000/health
   # Should return: {"status":"ok","timestamp":"..."}
   ```

2. Check the dashboard:
   - Open http://localhost:3000 in your web browser
   - You should see the AI-Orchestrator dashboard

3. Check the logs:
   ```bash
   tail -f logs/application.log
   ```

## Troubleshooting

### Common Issues

#### "Claude command not found"
- Ensure Claude Code CLI is installed and in your PATH
- Try restarting your terminal after installation
- Verify with `which claude` (Linux/Mac) or `where claude` (Windows)

#### Port already in use
- Change the port in config/development.yaml or config/production.yaml
- Or stop the existing process using that port
- Use a different port when starting: `node src/index.js start --port 3001`

#### Permission errors
- Ensure you have read/write permissions to the logs and config directories
- On Linux/Mac: `sudo chown -R $USER:$USER ai-orchestrator`
- On Windows: Run terminal as Administrator or adjust folder permissions

#### Configuration errors
- Check that YAML files are valid (no syntax errors)
- Verify required fields are present
- Look at error messages for specific guidance

### Getting Help

1. Check the troubleshooting guide: `TROUBLESHOOTING.md`
2. Review the FAQ section in the documentation
3. Search existing issues in the repository
4. Create a new issue with detailed information including:
   - Operating system and version
   - Node.js and npm versions
   - Claude Code CLI version
   - Error messages and logs
   - Steps to reproduce the issue