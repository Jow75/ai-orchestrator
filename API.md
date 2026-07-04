# API Reference

API documentation for AI-Orchestrator's REST and WebSocket interfaces.

## Base URL
```
http://localhost:3000/api
```

## Authentication
API Key authentication via Authorization header:
```
Authorization: Bearer <your-api-key>
```
Set API key in configuration:
```yaml
security:
  apiKey: "your-secret-key"
```

## Rate Limiting
Default: 100 requests per 15 minutes per IP
Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

## Error Responses
```json
{
  "success": false,
  "data": null,
  "error": {
    "message": "Error description",
    "code": "ERROR_CODE"
  }
}
```

## Success Responses
```json
{
  "success": true,
  "data": { /* response data */ },
  "error": null
}
```

## Endpoints

### System
- `GET /health` - Basic health check
- `GET /status` - Full system status
- `GET /config` - Non-sensitive configuration
- `GET /metrics` - System metrics

### Orchestrator
- `GET /orchestrator` - Orchestrator statistics
- `GET /agents` - List all agents
- `GET /agents/:id` - Get specific agent
- `POST /tasks` - Submit new task
- `GET /tasks` - Get task queue statistics
- `GET /tasks/:id` - Get specific task

### Sessions
- `GET /sessions` - List all sessions
- `POST /sessions` - Create new session
- `GET /sessions/:id` - Get specific session
- `PUT /sessions/:id/start` - Start session
- `PUT /sessions/:id/end` - End session
- `POST /sessions/:id/checkpoint` - Create checkpoint

### Logs
- `GET /logs` - Retrieve application logs

### WebSocket Events
Connection: `io('http://localhost:3000')`

**Server → Client:**
- `status-update` - System status changes
- `agents-update` - Agent status changes
- `tasks-update` - Task queue changes
- `sessions-update` - Session list changes
- `metrics-update` - Metrics updates
- `health-update` - Health check results
- `log-entry` - New log entries
- `notification` - System notifications

**Client → Server:**
- `subscribe` - `{ events: [...] }`
- `unsubscribe` - `{ events: [...] }`
- `get-status` - Request current status
- `get-agents` - Request agent list
- `get-tasks` - Request task queue
- `get-sessions` - Request session list
- `get-metrics` - Request metrics

## Examples

### Get System Status
```bash
curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/status
```

### Submit a Task
```bash
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"code-generation","payload":{"language":"python","spec":"Create a REST API"}}' \
  http://localhost:3000/api/tasks
```

### Start WebSocket Connection (JavaScript)
```javascript
const socket = io('http://localhost:3000', {
  auth: {
    token: 'your-api-key'
  }
});

socket.on('connect', () => {
  console.log('Connected to API');
  socket.emit('subscribe', { events: ['status', 'agents', 'tasks'] });
});

socket.on('status-update', (data) => {
  console.log('Status update:', data);
});
```