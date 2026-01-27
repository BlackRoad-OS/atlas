/**
 * ⬛⬜🛣️ BlackRoad Atlas - Queue Handler
 *
 * Processes async job messages from queues:
 * - atlas-jobs: General job execution
 * - atlas-sync: Repository synchronization
 * - atlas-resolution: Self-resolution tasks
 */

import type { Env, QueueMessage, QueueMessageType } from '../types';

export async function handleQueue(
  batch: MessageBatch<QueueMessage>,
  env: Env
): Promise<void> {
  const queueName = batch.queue;
  console.log(`[Queue] Processing ${batch.messages.length} messages from ${queueName}`);

  const results = await Promise.allSettled(
    batch.messages.map(async (message) => {
      const msg = message.body;
      console.log(`[Queue] Processing message: ${msg.type} (${msg.correlationId || 'no-correlation'})`);

      try {
        await processMessage(msg, env);
        message.ack();
        console.log(`[Queue] Message ${msg.type} completed successfully`);
      } catch (error) {
        console.error(`[Queue] Message ${msg.type} failed:`, error);

        const attemptCount = (msg.attemptCount || 0) + 1;

        // Retry with backoff if under max attempts
        if (attemptCount < 5) {
          message.retry({
            delaySeconds: Math.pow(2, attemptCount) // Exponential backoff
          });
        } else {
          // Move to DLQ by not acknowledging or retrying
          console.error(`[Queue] Message ${msg.type} exceeded max retries, moving to DLQ`);
          message.ack(); // Ack to prevent infinite retry, will go to DLQ based on config
        }
      }
    })
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(`[Queue] Batch complete: ${succeeded} succeeded, ${failed} failed`);
}

async function processMessage(msg: QueueMessage, env: Env): Promise<void> {
  const handlers: Record<QueueMessageType, () => Promise<void>> = {
    'job:execute': () => handleJobExecute(msg, env),
    'job:retry': () => handleJobRetry(msg, env),
    'sync:repo': () => handleSyncRepo(msg, env),
    'sync:all': () => handleSyncAll(msg, env),
    'resolve:issue': () => handleResolveIssue(msg, env),
    'resolve:auto': () => handleResolveAuto(msg, env),
    'health:check': () => handleHealthCheck(msg, env),
    'cohesiveness:analyze': () => handleCohesivenessAnalyze(msg, env)
  };

  const handler = handlers[msg.type];
  if (!handler) {
    throw new Error(`Unknown message type: ${msg.type}`);
  }

  await handler();
}

// Job execution handlers
async function handleJobExecute(msg: QueueMessage, env: Env): Promise<void> {
  const { jobId, jobType } = msg.payload as { jobId: string; jobType: string };

  const coordinatorId = env.JOB_COORDINATOR.idFromName('global');
  const coordinator = env.JOB_COORDINATOR.get(coordinatorId);

  await coordinator.fetch(new Request(`http://internal/jobs/${jobId}/execute`, {
    method: 'POST'
  }));
}

async function handleJobRetry(msg: QueueMessage, env: Env): Promise<void> {
  const { jobId } = msg.payload as { jobId: string };

  const coordinatorId = env.JOB_COORDINATOR.idFromName('global');
  const coordinator = env.JOB_COORDINATOR.get(coordinatorId);

  await coordinator.fetch(new Request(`http://internal/jobs/${jobId}/retry`, {
    method: 'POST'
  }));
}

// Repository sync handlers
async function handleSyncRepo(msg: QueueMessage, env: Env): Promise<void> {
  const { repo, force } = msg.payload as { repo: string; force?: boolean };

  const syncAgentId = env.REPO_SYNC_AGENT.idFromName('global');
  const syncAgent = env.REPO_SYNC_AGENT.get(syncAgentId);

  await syncAgent.fetch(new Request(`http://internal/sync/${encodeURIComponent(repo)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force })
  }));
}

async function handleSyncAll(msg: QueueMessage, env: Env): Promise<void> {
  const { force } = msg.payload as { force?: boolean };

  const syncAgentId = env.REPO_SYNC_AGENT.idFromName('global');
  const syncAgent = env.REPO_SYNC_AGENT.get(syncAgentId);

  await syncAgent.fetch(new Request('http://internal/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full: true, force })
  }));
}

// Resolution handlers
async function handleResolveIssue(msg: QueueMessage, env: Env): Promise<void> {
  const { issueId, action } = msg.payload as { issueId: string; action?: string };

  const healthMonitorId = env.HEALTH_MONITOR.idFromName('global');
  const healthMonitor = env.HEALTH_MONITOR.get(healthMonitorId);

  await healthMonitor.fetch(new Request(`http://internal/resolve/${issueId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  }));
}

async function handleResolveAuto(msg: QueueMessage, env: Env): Promise<void> {
  const issue = msg.payload;

  const healthMonitorId = env.HEALTH_MONITOR.idFromName('global');
  const healthMonitor = env.HEALTH_MONITOR.get(healthMonitorId);

  // Register the issue first
  const registerResponse = await healthMonitor.fetch(new Request('http://internal/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...issue,
      autoResolvable: true
    })
  }));

  const { issueId } = await registerResponse.json() as { issueId: string };

  // Attempt auto-resolution
  await healthMonitor.fetch(new Request(`http://internal/resolve/${issueId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auto: true })
  }));
}

// Health check handler
async function handleHealthCheck(msg: QueueMessage, env: Env): Promise<void> {
  const { component } = msg.payload as { component?: string };

  const healthMonitorId = env.HEALTH_MONITOR.idFromName('global');
  const healthMonitor = env.HEALTH_MONITOR.get(healthMonitorId);

  await healthMonitor.fetch(new Request('http://internal/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ component })
  }));
}

// Cohesiveness analysis handler
async function handleCohesivenessAnalyze(msg: QueueMessage, env: Env): Promise<void> {
  const { repos, full } = msg.payload as { repos?: string[]; full?: boolean };

  const checkerId = env.COHESIVENESS_CHECKER.idFromName('global');
  const checker = env.COHESIVENESS_CHECKER.get(checkerId);

  await checker.fetch(new Request('http://internal/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repos, full })
  }));
}
