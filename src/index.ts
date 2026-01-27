/**
 * ⬛⬜🛣️ BlackRoad Atlas - Cloudflare Workers Agent Jobs System
 *
 * Self-healing, auto-updating agent orchestration for BlackRoad OS repos
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { JobCoordinator } from './durable-objects/job-coordinator';
import { RepoSyncAgent } from './durable-objects/repo-sync-agent';
import { HealthMonitor } from './durable-objects/health-monitor';
import { CohesivenessChecker } from './durable-objects/cohesiveness-checker';
import { handleScheduled } from './handlers/scheduled';
import { handleQueue } from './handlers/queue';
import type { Env, QueueMessage } from './types';

// Re-export Durable Objects
export { JobCoordinator, RepoSyncAgent, HealthMonitor, CohesivenessChecker };

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', cors());
app.use('*', logger());

// Health check
app.get('/', (c) => {
  return c.json({
    name: 'BlackRoad Atlas',
    version: '0.1.0',
    status: 'operational',
    emoji: '⬛⬜🛣️',
    description: 'Cloudflare Workers Agent Jobs System',
    endpoints: {
      health: '/health',
      jobs: '/api/jobs',
      repos: '/api/repos',
      agents: '/api/agents',
      sync: '/api/sync',
      resolve: '/api/resolve'
    }
  });
});

// Health endpoint with detailed status
app.get('/health', async (c) => {
  const healthMonitorId = c.env.HEALTH_MONITOR.idFromName('global');
  const healthMonitor = c.env.HEALTH_MONITOR.get(healthMonitorId);

  const response = await healthMonitor.fetch(new Request('http://internal/status'));
  const status = await response.json();

  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    components: status
  });
});

// Jobs API
app.get('/api/jobs', async (c) => {
  const coordinatorId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('http://internal/jobs'));
  return c.json(await response.json());
});

app.post('/api/jobs', async (c) => {
  const body = await c.req.json();
  const coordinatorId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('http://internal/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }));

  return c.json(await response.json(), response.status as 200 | 201);
});

app.get('/api/jobs/:id', async (c) => {
  const jobId = c.req.param('id');
  const coordinatorId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request(`http://internal/jobs/${jobId}`));
  return c.json(await response.json(), response.status as 200 | 404);
});

// Repository sync API
app.get('/api/repos', async (c) => {
  const syncAgentId = c.env.REPO_SYNC_AGENT.idFromName('global');
  const syncAgent = c.env.REPO_SYNC_AGENT.get(syncAgentId);

  const response = await syncAgent.fetch(new Request('http://internal/repos'));
  return c.json(await response.json());
});

app.post('/api/sync', async (c) => {
  const body = await c.req.json<{ repos?: string[] }>();
  const syncAgentId = c.env.REPO_SYNC_AGENT.idFromName('global');
  const syncAgent = c.env.REPO_SYNC_AGENT.get(syncAgentId);

  const response = await syncAgent.fetch(new Request('http://internal/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }));

  return c.json(await response.json());
});

app.post('/api/sync/:repo', async (c) => {
  const repo = c.req.param('repo');
  const syncAgentId = c.env.REPO_SYNC_AGENT.idFromName('global');
  const syncAgent = c.env.REPO_SYNC_AGENT.get(syncAgentId);

  const response = await syncAgent.fetch(new Request(`http://internal/sync/${repo}`, {
    method: 'POST'
  }));

  return c.json(await response.json());
});

// Cohesiveness API
app.get('/api/cohesiveness', async (c) => {
  const checkerId = c.env.COHESIVENESS_CHECKER.idFromName('global');
  const checker = c.env.COHESIVENESS_CHECKER.get(checkerId);

  const response = await checker.fetch(new Request('http://internal/report'));
  return c.json(await response.json());
});

app.post('/api/cohesiveness/analyze', async (c) => {
  const checkerId = c.env.COHESIVENESS_CHECKER.idFromName('global');
  const checker = c.env.COHESIVENESS_CHECKER.get(checkerId);

  const response = await checker.fetch(new Request('http://internal/analyze', {
    method: 'POST'
  }));

  return c.json(await response.json());
});

// Self-resolution API
app.post('/api/resolve', async (c) => {
  const body = await c.req.json<{ issue?: string; auto?: boolean }>();
  const healthMonitorId = c.env.HEALTH_MONITOR.idFromName('global');
  const healthMonitor = c.env.HEALTH_MONITOR.get(healthMonitorId);

  const response = await healthMonitor.fetch(new Request('http://internal/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }));

  return c.json(await response.json());
});

// Agents status
app.get('/api/agents', async (c) => {
  const [coordinatorStatus, syncStatus, healthStatus, cohesivenessStatus] = await Promise.all([
    (async () => {
      const id = c.env.JOB_COORDINATOR.idFromName('global');
      const obj = c.env.JOB_COORDINATOR.get(id);
      const res = await obj.fetch(new Request('http://internal/status'));
      return res.json();
    })(),
    (async () => {
      const id = c.env.REPO_SYNC_AGENT.idFromName('global');
      const obj = c.env.REPO_SYNC_AGENT.get(id);
      const res = await obj.fetch(new Request('http://internal/status'));
      return res.json();
    })(),
    (async () => {
      const id = c.env.HEALTH_MONITOR.idFromName('global');
      const obj = c.env.HEALTH_MONITOR.get(id);
      const res = await obj.fetch(new Request('http://internal/status'));
      return res.json();
    })(),
    (async () => {
      const id = c.env.COHESIVENESS_CHECKER.idFromName('global');
      const obj = c.env.COHESIVENESS_CHECKER.get(id);
      const res = await obj.fetch(new Request('http://internal/status'));
      return res.json();
    })()
  ]);

  return c.json({
    agents: {
      jobCoordinator: coordinatorStatus,
      repoSyncAgent: syncStatus,
      healthMonitor: healthStatus,
      cohesivenessChecker: cohesivenessStatus
    },
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.notFound((c) => {
  return c.json({
    error: 'Not Found',
    message: `Route ${c.req.method} ${c.req.path} not found`,
    availableRoutes: ['/', '/health', '/api/jobs', '/api/repos', '/api/sync', '/api/agents', '/api/cohesiveness', '/api/resolve']
  }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({
    error: 'Internal Server Error',
    message: err.message,
    stack: c.env.ENVIRONMENT === 'development' ? err.stack : undefined
  }, 500);
});

// Export the worker
export default {
  fetch: app.fetch,

  // Scheduled handler for cron triggers
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await handleScheduled(event, env, ctx);
  },

  // Queue handler for async job processing
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    await handleQueue(batch, env);
  }
};
