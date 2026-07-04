# Troubleshooting Guide

This guide helps you diagnose and resolve common issues with AI-Orchestrator.

## Installation Issues

### Node.js Version Errors
**Symptoms:** 
- Error during `npm install`: "engine not compatible"
- Application fails to start with Node.js version errors

**Solution:**
AI-Orchestrator requires Node.js >=18.0.0. Check your version:
```bash
node --version
```

If you have an older version:
- Use nvm (Node Version Manager): `nvm install 18 && nvm use 18`
- Or download the latest Node.js from https://nodejs.org

### Dependency Installation Failures
**Symptoms:**
- npm ERR! messages during `npm install`
- Missing module errors when starting

**Solutions:**
1. Clear npm cache and retry:
   ```bash
   npm cache clean --force
   npm install
   ```

2. If using Windows, ensure you have:
   - Python 2.7, 3.5, 3.6, 3.7, or 3.8 installed
   - Microsoft Visual C++ Build Tools
   - Git for Windows

3. Try with legacy peer dependencies:
   ```bash
   npm install --legacy-peer-deps
   ```

### Port Already in Use
**Symptoms:**
- Error: "EADDRINUSE: address already in use :::3000"
- Application fails to start

**Solutions:**
1. Find and stop the process using the port:
   ```bash
   # Windows
   netstat -ano | findstr :3000
   taskkill /PID <PID> /F
   
   # Linux/Mac
   lsof -i :3000
   kill -9 <PID>
   ```

2. Change the port in configuration:
   ```yaml
   # In config/development.yaml or config/production.yaml
   server:
     port: 3001
   ```

3. Or specify port when starting:
   ```bash
   node src/index.js start --port 3001
   ```

## Runtime Issues

### Application Won't Start
**Symptoms:**
- Process exits immediately after starting
- No error message displayed
- Service fails to initialize

**Solutions:**
1. Check the logs for detailed error messages:
   ```bash
   cat logs/error-*.log
   ```

2. Common startup failures:
   - **Missing Claude CLI**: Ensure Claude Code is installed and in PATH
   - **Invalid Configuration**: Check YAML syntax in config files
   - **Permission Issues**: Ensure read/write access to logs/, config/, data/ directories
   - **Database Issues**: Ensure SQLite can create/write to the database file

### Claude Driver Issues
**Symptoms:**
- "Claude command not found" errors
- Claude processes failing to start
- Communication timeouts with Claude

**Solutions:**
1. Verify Claude Code installation:
   ```bash
   claude --version
   # Should return version number
   ```

2. If not found, install Claude Code:
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

3. Check PATH environment variable includes Claude installation directory

4. Specify explicit path in configuration:
   ```yaml
   # In config/*.yaml under drivers section
   claude:
     claudePath: "/usr/local/bin/claude"  # or full path to claude executable
   ```

5. Ensure sufficient permissions to execute Claude

### Database Errors
**Symptoms:**
- "SQLITE_ERROR: unable to open database file"
- Database lock errors
- Missing table errors

**Solutions:**
1. Check directory permissions:
   ```bash
   ls -la data/
   # Should be readable/writable by the process
   ```

2. Ensure sufficient disk space

3. For corruption issues, restore from backup or delete and let it recreate:
   ```bash
   # Backup first if data is important
   mv data/orchestrator.db data/orchestrator.db.backup
   # System will create a new database on next start
   ```

4. For PostgreSQL/MySQL, verify:
   - Database server is running
   - Connection credentials are correct
   - Database exists and user has proper permissions

### Memory Issues
**Symptoms:**
- Process crashes with "Out of memory" error
- Slow performance over time
- Frequent garbage collection pauses

**Solutions:**
1. Increase available memory or reduce memory usage:
   ```yaml
   # In config/*.yaml
   cache:
     maxKeys: 5000  # Reduced from 10000
   ```

2. Adjust agent limits:
   ```yaml
   orchestrator:
     maxConcurrentAgents: 5  # Reduced from 10
   ```

3. Enable heap profiling to identify leaks:
   ```bash
   node --inspect src/index.js start
   ```

4. Regularly restart the service (can be automated with process managers)

### Performance Problems
**Symptoms:**
- Slow response times
- Task queue backing up
- High CPU usage

**Solutions:**
1. Check system resources:
   ```bash
   # Linux/Mac
   top
   
   # Windows Task Manager or
   wmic cpu get loadpercentage
   ```

2. Review agent utilization:
   - Are agents constantly busy? Consider increasing pool sizes
   - Are agents frequently idle? Consider decreasing pool sizes

3. Check task complexity:
   - Very large tasks may need timeout increases
   - Complex prompts may exceed model capabilities

4. Review configuration:
   ```yaml
   # Increase timeouts for complex operations
   orchestrator:
     defaultTimeout: 600000  # 10 minutes instead of 5
   ```

5. Consider horizontal scaling:
   - Run multiple instances behind a load balancer
   - Use shared database and Redis for state synchronization

## Configuration Issues

### Invalid YAML
**Symptoms:**
- Error during startup: "Failed to parse config file"
- Vague configuration errors

**Solutions:**
1. Validate YAML syntax with online validator or:
   ```bash
   # Install yaml-cli if needed
   npm install -g yaml-cli
   
   # Validate file
   yamllint config/development.yaml
   ```

2. Common YAML mistakes:
   - Using tabs instead of spaces
   - Incorrect indentation
   - Missing colons after keys
   - Special characters not properly quoted

### Environment Variable Conflicts
**Symptoms:**
- Configuration not matching expected values
- Environment variables not being applied

**Solutions:**
1. Check variable naming convention:
   - Must be prefixed with `APP_`
   - Nested keys use underscores: `APP_SERVER_PORT=8080`
   - Case insensitive but conventionally uppercase

2. Verify order of precedence:
   Command line args > Environment variables > Config files

3. Check for overridden values in later configuration files:
   - local.yaml overrides development.yaml
   - development.yaml overrides default.yaml

## Network Issues

### Connection Refused Errors
**Symptoms:**
- Unable to connect to API
- WebSocket connection failures
- Timeout errors

**Solutions:**
1. Verify service is running:
   ```bash
   ps aux | grep node
   # or
   tasklist | grep node
   ```

2. Check binding address:
   - `127.0.0.1` or `localhost` only allows local connections
   - `0.0.0.0` allows external connections
   ```yaml
   server:
     host: "0.0.0.0"  # for external access
   ```

3. Check firewall settings:
   - Ensure port 3000 (or configured port) is allowed
   - On Windows: Check Windows Firewall settings
   - On Linux: Check iptables/firewalld/ufw

### External Service Integration Issues
**Symptoms:**
- Notification failures (email, Slack, webhook)
- Database connection errors
- External API timeouts

**Solutions:**
1. Test connectivity manually:
   ```bash
   # Test webhook
   curl -X POST https://your-webhook-url.com -H "Content-Type: application/json" -d '{"test":true}'
   
   # Test email (if using SMTP)
   telnet smtp.gmail.com 587
   
   # Test database
   psql -h localhost -U user database
   ```

2. Check credentials and permissions

3. Verify network access from the server running AI-Orchestrator

4. Review timeout values in configuration:
   ```yaml
   notifications:
     email:
       timeout: 10000  # Increase if needed
   ```

## Logging and Debugging

### Enabling Debug Logging
**Temporary method:**
```bash
# Set environment variable
export APP_LOGGING_LEVEL=debug
node src/index.js start
```

**Permanent method:**
```yaml
# In config/development.yaml or config/production.yaml
logging:
  level: "debug"
```

### Collecting Diagnostic Information
Run the built-in diagnostics:
```bash
node src/index.js doctor
```

This checks:
- Node.js version
- Required directories and permissions
- Claude availability
- Configuration validity
- Basic connectivity

### Log Analysis
Common patterns to look for in logs:

1. **Repeated errors**: Indicate persistent issues needing attention
2. **Timeout messages**: May indicate need to increase timeout values
3. **Memory warnings**: Suggest potential memory leaks
4. **Authentication failures**: Indicate credential or permission issues
5. **Network timeouts**: Suggest connectivity problems or service unavailability

### Debug Mode
Enable additional debugging:
```bash
# Enable verbose logging
NODE_DEBUG=http,net,fs node src/index.js start

# Or use Node.js inspector
node --inspect-brk src/index.js start
# Then connect with Chrome DevTools at chrome://inspect
```

## Recovery Procedures

### Manual Recovery from Stuck State
If the system becomes unresponsive:

1. Check process status:
   ```bash
   ps aux | grep node  # Linux/Mac
   tasklist | findstr node  # Windows
   ```

2. Examine recent logs:
   ```bash
   tail -n 50 logs/error-*.log
   tail -n 50 logs/application-*.log
   ```

3. Attempt graceful shutdown:
   ```bash
   # Send SIGTERM
   kill <PID>  # Linux/Mac
   taskkill /PID <PID>  # Windows
   ```

4. If unresponsive after 30 seconds, force kill:
   ```bash
   kill -9 <PID>  # Linux/Mac
   taskkill /F /PID <PID>  # Windows
   ```

5. Restart the service:
   ```bash
   node src/index.js start
   ```

### Restoring from Backup
If data corruption occurs:

1. Stop the service:
   ```bash
   node src/index.js stop
   ```

2. Backup current (potentially corrupted) data:
   corrupted) data:
   ```bash
   mkdir -p backup/$(date +%Y%m%d_%H%M%S)
   cp -r data/ backup/$(date +%Y%m%d_%H%M%S)/
   cp -r logs/ backup/$(date +%Y%m%d_%H%M%S)/
   cp -r config/ backup/$(date +%Y%m%d_%H%M%S)/  # if config modified
   ```

3. Replace with known good backup:
   ```bash
   # Assuming you have a backup directory
   rm -rf data/ logs/
   cp -r backup/20260601_120000/data/ .
   cp -r backup/20260601_120000/logs/ .
   ```

4. Restart the service:
   ```bash
   node src/index.js start
   ```

## Specific Error Messages

### "Error: spawn claude ENOENT"
**Meaning:** Cannot find the Claude executable
**Solution:** Install Claude Code or correct the path in configuration

### "Error: listen EADDRINUSE"
**Meaning:** Port already in use
**Solution:** Kill existing process or change port

### "Error: SQLITE_CANTOPEN: unable to open database file"
**Meaning:** Cannot access database file
**Solution:** Check file permissions and disk space

### "Error: socket hang up"
**Meaning:** Prematurely closed connection
**Solution:** Check network stability, increase timeouts

### "Error: Request failed with status code 429"
**Meaning:** Rate limit exceeded (typically from external APIs)
**Solution:** The rate limiting system should handle this automatically. Check if custom rate limits are too low.

### "FATAL ERROR: Reached heap limit"
**Meaning:** Out of memory
**Solution:** Increase memory limit or reduce memory usage

## When to Seek Help

If you've tried the above solutions and still experience issues:

1. Gather information:
   - Exact error messages
   - Steps to reproduce
   - System information (OS, Node.js version, etc.)
   - Relevant log snippets
   - Configuration details (remove secrets)

2. Check existing issues in the repository

3. Create a detailed issue report including all gathered information

4. For critical production issues, consider contacting professional support if available

## Preventive Maintenance

To minimize issues:

1. **Regular Updates**: Keep Node.js, dependencies, and Claude Code updated
2. **Monitor Logs**: Set up log monitoring and alerts for error patterns
3. **Resource Monitoring**: Track CPU, memory, and disk usage
4. **Backup Regularly**: Automate backups of configuration and data
5. **Health Checks**: Implement automated health checks and restart policies
6. **Load Testing**: Periodically test system under expected loads
7. **Security Updates**: Promptly apply security patches to dependencies