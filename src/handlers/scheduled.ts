/**
 * ⬛⬜🛣️ BlackRoad Atlas - Scheduled (Cron) Handler
 *
 * Handles scheduled triggers for:
 * - Health checks & auto-updates (every 5 minutes)
 * - Full repo sync (every hour)
 * - Cohesiveness analysis (daily)
 */

import type { Env } from '../types';

export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const cronPattern = event.cron;
  const timestamp = new Date(event.scheduledTime).toISOString();

  console.log(`[Scheduled] Cron triggered: ${cronPattern} at ${timestamp}`);

  try {
    switch (cronPattern) {
      // Every 5 minutes - health check & auto-update
      case '*/5 * * * *':
        await handleHealthCheckAndAutoUpdate(env, ctx);
        break;

      // Every hour - full repo sync
      case '0 * * * *':
        await handleFullRepoSync(env, ctx);
        break;

      // Daily - cohesiveness analysis
      case '0 0 * * *':
        await handleCohesivenessAnalysis(env, ctx);
        break;

      default:
        console.warn(`[Scheduled] Unknown cron pattern: ${cronPattern}`);
    }
  } catch (error) {
    console.error(`[Scheduled] Error handling cron ${cronPattern}:`, error);

    // Trigger self-resolution for scheduled task failures
    if (env.SELF_HEAL_ENABLED === 'true') {
      ctx.waitUntil(triggerSelfResolution(env, {
        type: 'sync_failure',
        component: 'scheduled',
        description: `Scheduled task failed: ${cronPattern}`,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }
}

async function handleHealthCheckAndAutoUpdate(env: Env, ctx: ExecutionContext): Promise<void> {
  console.log('[Scheduled] Running health check and auto-update');

  // Get health monitor status
  const healthMonitorId = env.HEALTH_MONITOR.idFromName('global');
  const healthMonitor = env.HEALTH_MONITOR.get(healthMonitorId);

  const healthResponse = await healthMonitor.fetch(new Request('http://internal/check', {
    method: 'POST'
  }));
  const healthResult = await healthResponse.json() as { healthy: boolean; issues?: unknown[] };

  // If there are issues and self-heal is enabled, trigger resolution
  if (!healthResult.healthy && env.SELF_HEAL_ENABLED === 'true') {
    console.log('[Scheduled] Health issues detected, triggering self-resolution');
    await healthMonitor.fetch(new Request('http://internal/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto: true })
    }));
  }

  // Check for updates on monitored repos
  const syncAgentId = env.REPO_SYNC_AGENT.idFromName('global');
  const syncAgent = env.REPO_SYNC_AGENT.get(syncAgentId);

  await syncAgent.fetch(new Request('http://internal/check-updates', {
    method: 'POST'
  }));

  console.log('[Scheduled] Health check and auto-update completed');
}

async function handleFullRepoSync(env: Env, ctx: ExecutionContext): Promise<void> {
  console.log('[Scheduled] Running full repo sync');

  const syncAgentId = env.REPO_SYNC_AGENT.idFromName('global');
  const syncAgent = env.REPO_SYNC_AGENT.get(syncAgentId);

  await syncAgent.fetch(new Request('http://internal/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full: true })
  }));

  console.log('[Scheduled] Full repo sync initiated');
}

async function handleCohesivenessAnalysis(env: Env, ctx: ExecutionContext): Promise<void> {
  console.log('[Scheduled] Running cohesiveness analysis');

  const checkerId = env.COHESIVENESS_CHECKER.idFromName('global');
  const checker = env.COHESIVENESS_CHECKER.get(checkerId);

  const analysisResponse = await checker.fetch(new Request('http://internal/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full: true })
  }));

  const result = await analysisResponse.json() as { violations?: unknown[] };

  // If there are auto-fixable violations and self-heal is enabled, fix them
  if (result.violations && env.SELF_HEAL_ENABLED === 'true') {
    await checker.fetch(new Request('http://internal/auto-fix', {
      method: 'POST'
    }));
  }

  console.log('[Scheduled] Cohesiveness analysis completed');
}

async function triggerSelfResolution(
  env: Env,
  issue: {
    type: string;
    component: string;
    description: string;
    error: string;
  }
): Promise<void> {
  await env.RESOLUTION_QUEUE.send({
    type: 'resolve:auto',
    payload: issue,
    timestamp: new Date().toISOString(),
    correlationId: crypto.randomUUID()
  });
}
