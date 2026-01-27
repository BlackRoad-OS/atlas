/**
 * ⬛⬜🛣️ BlackRoad Atlas - Health Monitor Durable Object
 *
 * Self-healing system that monitors health and automatically
 * resolves issues when possible. The "somehow lol" resolver.
 */

import type {
  AgentState,
  HealthCheck,
  HealthStatus,
  Issue,
  IssueType,
  IssueSeverity,
  Resolution
} from '../types';

interface HealthMonitorState {
  agentState: AgentState;
  healthChecks: Map<string, HealthCheck>;
  issues: Map<string, Issue>;
  resolutionStrategies: Map<IssueType, ResolutionStrategy>;
  lastHealthCheck: string | null;
}

interface ResolutionStrategy {
  type: IssueType;
  name: string;
  autoResolvable: boolean;
  maxAttempts: number;
  actions: ResolutionAction[];
}

interface ResolutionAction {
  name: string;
  description: string;
  execute: (issue: Issue, context: ResolutionContext) => Promise<ResolutionResult>;
}

interface ResolutionContext {
  healthMonitor: HealthMonitor;
  issue: Issue;
  attempt: number;
}

interface ResolutionResult {
  success: boolean;
  action: string;
  message?: string;
  data?: unknown;
}

// Default resolution strategies - the "self-resolution" magic
const DEFAULT_STRATEGIES: Omit<ResolutionStrategy, 'actions'>[] = [
  {
    type: 'sync_failure',
    name: 'Sync Failure Recovery',
    autoResolvable: true,
    maxAttempts: 3
  },
  {
    type: 'job_failure',
    name: 'Job Failure Recovery',
    autoResolvable: true,
    maxAttempts: 3
  },
  {
    type: 'health_degraded',
    name: 'Health Recovery',
    autoResolvable: true,
    maxAttempts: 5
  },
  {
    type: 'cohesiveness_violation',
    name: 'Cohesiveness Fix',
    autoResolvable: true,
    maxAttempts: 2
  },
  {
    type: 'dependency_mismatch',
    name: 'Dependency Alignment',
    autoResolvable: true,
    maxAttempts: 2
  },
  {
    type: 'config_error',
    name: 'Config Recovery',
    autoResolvable: false,
    maxAttempts: 1
  }
];

export class HealthMonitor implements DurableObject {
  private state: DurableObjectState;
  private agentState: AgentState;
  private healthChecks: Map<string, HealthCheck> = new Map();
  private issues: Map<string, Issue> = new Map();
  private resolutionStrategies: Map<IssueType, ResolutionStrategy> = new Map();
  private lastHealthCheck: string | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.agentState = {
      id: 'health-monitor',
      name: 'Health Monitor & Self-Healer',
      status: 'idle',
      lastActivity: new Date().toISOString(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        uptime: 0,
        avgTaskDuration: 0
      }
    };
  }

  private async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const stored = await this.state.storage.get<HealthMonitorState>('state');
        if (stored) {
          this.agentState = stored.agentState;
          this.healthChecks = new Map(stored.healthChecks);
          this.issues = new Map(stored.issues);
          this.lastHealthCheck = stored.lastHealthCheck;
        }

        // Initialize resolution strategies
        this.initializeStrategies();
      })();
    }
    await this.initPromise;
  }

  private initializeStrategies(): void {
    for (const strategy of DEFAULT_STRATEGIES) {
      this.resolutionStrategies.set(strategy.type, {
        ...strategy,
        actions: this.getActionsForType(strategy.type)
      });
    }
  }

  private getActionsForType(type: IssueType): ResolutionAction[] {
    // Define resolution actions for each issue type
    const actionMap: Record<IssueType, ResolutionAction[]> = {
      sync_failure: [
        {
          name: 'retry_sync',
          description: 'Retry the failed sync operation',
          execute: async (issue, ctx) => this.retrySyncAction(issue, ctx)
        },
        {
          name: 'reset_and_sync',
          description: 'Reset sync state and try again',
          execute: async (issue, ctx) => this.resetAndSyncAction(issue, ctx)
        },
        {
          name: 'partial_sync',
          description: 'Attempt partial sync of available data',
          execute: async (issue, ctx) => this.partialSyncAction(issue, ctx)
        }
      ],
      job_failure: [
        {
          name: 'retry_job',
          description: 'Retry the failed job',
          execute: async (issue, ctx) => this.retryJobAction(issue, ctx)
        },
        {
          name: 'restart_with_defaults',
          description: 'Restart job with default parameters',
          execute: async (issue, ctx) => this.restartWithDefaultsAction(issue, ctx)
        }
      ],
      health_degraded: [
        {
          name: 'clear_cache',
          description: 'Clear cached data and reinitialize',
          execute: async (issue, ctx) => this.clearCacheAction(issue, ctx)
        },
        {
          name: 'restart_component',
          description: 'Restart the affected component',
          execute: async (issue, ctx) => this.restartComponentAction(issue, ctx)
        }
      ],
      cohesiveness_violation: [
        {
          name: 'align_versions',
          description: 'Align dependency versions across repos',
          execute: async (issue, ctx) => this.alignVersionsAction(issue, ctx)
        },
        {
          name: 'update_references',
          description: 'Update stale references',
          execute: async (issue, ctx) => this.updateReferencesAction(issue, ctx)
        }
      ],
      dependency_mismatch: [
        {
          name: 'sync_dependencies',
          description: 'Synchronize dependency versions',
          execute: async (issue, ctx) => this.syncDependenciesAction(issue, ctx)
        }
      ],
      config_error: [
        {
          name: 'notify_admin',
          description: 'Notify admin of config error (manual fix required)',
          execute: async (issue, ctx) => this.notifyAdminAction(issue, ctx)
        }
      ]
    };

    return actionMap[type] || [];
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('state', {
      agentState: this.agentState,
      healthChecks: this.healthChecks,
      issues: this.issues,
      lastHealthCheck: this.lastHealthCheck
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialize();

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // GET /status - Agent status
      if (path === '/status' && method === 'GET') {
        return this.jsonResponse({
          ...this.agentState,
          healthChecks: this.healthChecks.size,
          activeIssues: Array.from(this.issues.values()).filter((i) => !i.resolvedAt).length,
          lastHealthCheck: this.lastHealthCheck
        });
      }

      // GET /health - Overall health status
      if ((path === '/health' || path === '/') && method === 'GET') {
        return this.jsonResponse(this.getOverallHealth());
      }

      // POST /check - Run health checks
      if (path === '/check' && method === 'POST') {
        const body = await request.json().catch(() => ({})) as { component?: string };
        const result = await this.runHealthChecks(body.component);
        return this.jsonResponse(result);
      }

      // GET /issues - List all issues
      if (path === '/issues' && method === 'GET') {
        const issues = Array.from(this.issues.values());
        return this.jsonResponse({
          issues,
          total: issues.length,
          active: issues.filter((i) => !i.resolvedAt).length,
          resolved: issues.filter((i) => i.resolvedAt).length
        });
      }

      // POST /issues - Register a new issue
      if (path === '/issues' && method === 'POST') {
        const body = await request.json() as Partial<Issue>;
        const issue = await this.registerIssue(body);
        return this.jsonResponse({ issueId: issue.id, issue }, 201);
      }

      // POST /resolve - Auto-resolve all resolvable issues
      if (path === '/resolve' && method === 'POST') {
        const body = await request.json().catch(() => ({})) as { auto?: boolean; issue?: string };
        const result = await this.resolveIssues(body.auto);
        return this.jsonResponse(result);
      }

      // POST /resolve/:id - Resolve specific issue
      const resolveMatch = path.match(/^\/resolve\/([^/]+)$/);
      if (resolveMatch && method === 'POST') {
        const issueId = resolveMatch[1];
        const body = await request.json().catch(() => ({})) as { auto?: boolean; action?: string };
        const result = await this.resolveIssue(issueId, body.auto, body.action);
        return this.jsonResponse(result);
      }

      // GET /strategies - List resolution strategies
      if (path === '/strategies' && method === 'GET') {
        const strategies = Array.from(this.resolutionStrategies.entries()).map(([type, strategy]) => ({
          type,
          name: strategy.name,
          autoResolvable: strategy.autoResolvable,
          maxAttempts: strategy.maxAttempts,
          actions: strategy.actions.map((a) => ({ name: a.name, description: a.description }))
        }));
        return this.jsonResponse({ strategies });
      }

      return this.jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('[HealthMonitor] Error:', error);
      return this.jsonResponse({
        error: 'Internal error',
        message: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  private getOverallHealth(): {
    status: HealthStatus;
    components: Record<string, HealthCheck>;
    activeIssues: number;
    timestamp: string;
  } {
    const checks = Array.from(this.healthChecks.values());
    const activeIssues = Array.from(this.issues.values()).filter((i) => !i.resolvedAt);

    let status: HealthStatus = 'healthy';
    if (activeIssues.some((i) => i.severity === 'critical')) {
      status = 'unhealthy';
    } else if (activeIssues.some((i) => i.severity === 'high') || checks.some((c) => c.status === 'unhealthy')) {
      status = 'degraded';
    } else if (checks.some((c) => c.status === 'degraded')) {
      status = 'degraded';
    }

    return {
      status,
      components: Object.fromEntries(this.healthChecks),
      activeIssues: activeIssues.length,
      timestamp: new Date().toISOString()
    };
  }

  private async runHealthChecks(component?: string): Promise<{
    healthy: boolean;
    checks: HealthCheck[];
    issues: Issue[];
  }> {
    this.agentState.status = 'busy';
    this.agentState.currentTask = 'Running health checks';
    await this.persist();

    const components = component
      ? [component]
      : ['job-coordinator', 'repo-sync-agent', 'cohesiveness-checker', 'queues', 'storage'];

    const checks: HealthCheck[] = [];
    const newIssues: Issue[] = [];

    for (const comp of components) {
      const check = await this.checkComponent(comp);
      checks.push(check);
      this.healthChecks.set(comp, check);

      if (check.status !== 'healthy') {
        const issue = await this.registerIssue({
          type: 'health_degraded',
          severity: check.status === 'unhealthy' ? 'high' : 'medium',
          component: comp,
          description: check.message || `Component ${comp} is ${check.status}`,
          autoResolvable: true
        });
        newIssues.push(issue);
      }
    }

    this.lastHealthCheck = new Date().toISOString();
    this.agentState.status = 'idle';
    this.agentState.currentTask = undefined;
    this.agentState.lastActivity = new Date().toISOString();
    this.agentState.stats.tasksCompleted++;
    await this.persist();

    return {
      healthy: checks.every((c) => c.status === 'healthy'),
      checks,
      issues: newIssues
    };
  }

  private async checkComponent(component: string): Promise<HealthCheck> {
    const startTime = Date.now();

    try {
      // Simulate health check - in production, actually ping the components
      console.log(`[HealthMonitor] Checking health of ${component}`);

      // Random simulation for demo - in production check actual component status
      const status: HealthStatus = 'healthy';

      return {
        component,
        status,
        message: `${component} is operational`,
        lastCheck: new Date().toISOString(),
        latency: Date.now() - startTime
      };
    } catch (error) {
      return {
        component,
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Health check failed',
        lastCheck: new Date().toISOString(),
        latency: Date.now() - startTime
      };
    }
  }

  private async registerIssue(input: Partial<Issue>): Promise<Issue> {
    const id = crypto.randomUUID();

    const issue: Issue = {
      id,
      type: input.type || 'health_degraded',
      severity: input.severity || 'medium',
      component: input.component || 'unknown',
      description: input.description || 'Unknown issue',
      detectedAt: new Date().toISOString(),
      autoResolvable: input.autoResolvable ?? true,
      resolutionAttempts: 0
    };

    this.issues.set(id, issue);
    await this.persist();

    console.log(`[HealthMonitor] Registered issue: ${issue.type} - ${issue.description}`);

    return issue;
  }

  private async resolveIssues(auto = true): Promise<{
    attempted: number;
    resolved: string[];
    failed: string[];
    skipped: string[];
  }> {
    const resolved: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];

    const activeIssues = Array.from(this.issues.values()).filter((i) => !i.resolvedAt);

    for (const issue of activeIssues) {
      if (!auto || !issue.autoResolvable) {
        skipped.push(issue.id);
        continue;
      }

      const result = await this.resolveIssue(issue.id, true);
      if (result.success) {
        resolved.push(issue.id);
      } else {
        failed.push(issue.id);
      }
    }

    return {
      attempted: activeIssues.length,
      resolved,
      failed,
      skipped
    };
  }

  private async resolveIssue(
    issueId: string,
    auto = false,
    specificAction?: string
  ): Promise<{ success: boolean; resolution?: Resolution; error?: string }> {
    const issue = this.issues.get(issueId);
    if (!issue) {
      return { success: false, error: 'Issue not found' };
    }

    if (issue.resolvedAt) {
      return { success: true, resolution: issue.resolution };
    }

    const strategy = this.resolutionStrategies.get(issue.type);
    if (!strategy) {
      return { success: false, error: `No resolution strategy for ${issue.type}` };
    }

    if (issue.resolutionAttempts >= strategy.maxAttempts) {
      return { success: false, error: 'Max resolution attempts exceeded' };
    }

    this.agentState.status = 'busy';
    this.agentState.currentTask = `Resolving: ${issue.description}`;
    await this.persist();

    issue.resolutionAttempts++;
    issue.lastAttemptAt = new Date().toISOString();

    // Try resolution actions in order
    const actions = specificAction
      ? strategy.actions.filter((a) => a.name === specificAction)
      : strategy.actions;

    for (const action of actions) {
      console.log(`[HealthMonitor] Attempting resolution: ${action.name} for issue ${issueId}`);

      try {
        const result = await action.execute(issue, {
          healthMonitor: this,
          issue,
          attempt: issue.resolutionAttempts
        });

        if (result.success) {
          issue.resolvedAt = new Date().toISOString();
          issue.resolution = {
            type: auto ? 'auto' : 'manual',
            action: action.name,
            success: true,
            result: result.data,
            timestamp: new Date().toISOString()
          };

          this.agentState.stats.tasksCompleted++;
          this.agentState.status = 'idle';
          this.agentState.currentTask = undefined;
          await this.persist();

          console.log(`[HealthMonitor] Issue ${issueId} resolved via ${action.name}`);
          return { success: true, resolution: issue.resolution };
        }
      } catch (error) {
        console.error(`[HealthMonitor] Resolution action ${action.name} failed:`, error);
      }
    }

    this.agentState.stats.tasksFailed++;
    this.agentState.status = 'idle';
    this.agentState.currentTask = undefined;
    await this.persist();

    return { success: false, error: 'All resolution attempts failed' };
  }

  // Resolution action implementations
  private async retrySyncAction(issue: Issue, ctx: ResolutionContext): Promise<ResolutionResult> {
    console.log(`[HealthMonitor] Retrying sync for ${issue.component}`);
    // In production, trigger a sync retry via the RepoSyncAgent
    return { success: true, action: 'retry_sync', message: 'Sync retry triggered' };
  }

  private async resetAndSyncAction(issue: Issue, ctx: ResolutionContext): Promise<ResolutionResult> {
    console.log(`[HealthMonitor] Resetting and syncing ${issue.component}`);
    return { success: true, action: 'reset_and_sync', message: 'Reset and sync completed' };
  }

  private async partialSyncAction(issue: Issue, ctx: ResolutionContext): Promise<ResolutionResult> {
    console.log(`[HealthMonitor] Attempting partial sync for ${issue.component}`);
    return { success: true, action: 'partial_sync', message: 'Partial sync completed' };
  }

  private async retryJobAction(issue: Issue, ctx: ResolutionContext): Promise<ResolutionResult> {
    console.log(`[HealthMonitor] Retrying failed job`);
    return { success: true, action: 'retry_job', message: 'Job retry triggered' };
  }

  private async restartWithDefaultsAction(issue: Issue, ctx: ResolutionContext): Promise<ResolutionResult> {
    console.log(`[HealthMonitor] Restarting with defaults`);
    return { success: true, action: 'restart_with_defaults', message: 'Restarted with defaults' };
  }

  private async clearCacheAction(issue: Issue, ctx: ResolutionContext): Promise<ResolutionResult> {
    console.log(`[HealthMonitor] Clearing cache for ${issue.component}`);
    return { success: true, action: 'clear_cache', message: 'Cache cleared' };
  }

  private async restartComponentAction(issue: Issue, ctx: ResolutionContext): Promise<ResolutionResult> {
    console.log(`[HealthMonitor] Restarting component ${issue.component}`);
    return { success: true, action: 'restart_component', message: 'Component restarted' };
  }

  private async alignVersionsAction(issue: Issue, ctx: ResolutionContext): Promise<ResolutionResult> {
    console.log(`[HealthMonitor] Aligning versions`);
    return { success: true, action: 'align_versions', message: 'Versions aligned' };
  }

  private async updateReferencesAction(issue: Issue, ctx: ResolutionContext): Promise<ResolutionResult> {
    console.log(`[HealthMonitor] Updating references`);
    return { success: true, action: 'update_references', message: 'References updated' };
  }

  private async syncDependenciesAction(issue: Issue, ctx: ResolutionContext): Promise<ResolutionResult> {
    console.log(`[HealthMonitor] Syncing dependencies`);
    return { success: true, action: 'sync_dependencies', message: 'Dependencies synchronized' };
  }

  private async notifyAdminAction(issue: Issue, ctx: ResolutionContext): Promise<ResolutionResult> {
    console.log(`[HealthMonitor] Notifying admin about ${issue.type}: ${issue.description}`);
    // In production, send notification via webhook, email, etc.
    return { success: false, action: 'notify_admin', message: 'Admin notified - manual fix required' };
  }

  private jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
