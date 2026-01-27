/**
 * ⬛⬜🛣️ BlackRoad Atlas - Job Coordinator Durable Object
 *
 * Manages job lifecycle, scheduling, and execution coordination.
 * Provides persistent state for jobs across worker invocations.
 */

import type { Job, JobStatus, JobPriority, AgentState, AgentStats } from '../types';

interface JobCoordinatorState {
  jobs: Map<string, Job>;
  agentState: AgentState;
  stats: {
    totalJobsCreated: number;
    totalJobsCompleted: number;
    totalJobsFailed: number;
  };
}

export class JobCoordinator implements DurableObject {
  private state: DurableObjectState;
  private jobs: Map<string, Job> = new Map();
  private agentState: AgentState;
  private stats = {
    totalJobsCreated: 0,
    totalJobsCompleted: 0,
    totalJobsFailed: 0
  };
  private initPromise: Promise<void> | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.agentState = {
      id: 'job-coordinator',
      name: 'Job Coordinator',
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
        // Load persisted state
        const stored = await this.state.storage.get<JobCoordinatorState>('state');
        if (stored) {
          this.jobs = new Map(stored.jobs);
          this.agentState = stored.agentState;
          this.stats = stored.stats;
        }
      })();
    }
    await this.initPromise;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('state', {
      jobs: this.jobs,
      agentState: this.agentState,
      stats: this.stats
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
          jobCount: this.jobs.size,
          stats: this.stats
        });
      }

      // GET /jobs - List all jobs
      if (path === '/jobs' && method === 'GET') {
        const jobs = Array.from(this.jobs.values()).sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        return this.jsonResponse({ jobs, total: jobs.length });
      }

      // POST /jobs - Create a new job
      if (path === '/jobs' && method === 'POST') {
        const body = await request.json() as Partial<Job>;
        const job = await this.createJob(body);
        return this.jsonResponse(job, 201);
      }

      // GET /jobs/:id - Get job by ID
      const jobIdMatch = path.match(/^\/jobs\/([^/]+)$/);
      if (jobIdMatch && method === 'GET') {
        const job = this.jobs.get(jobIdMatch[1]);
        if (!job) {
          return this.jsonResponse({ error: 'Job not found' }, 404);
        }
        return this.jsonResponse(job);
      }

      // POST /jobs/:id/execute - Execute a job
      const executeMatch = path.match(/^\/jobs\/([^/]+)\/execute$/);
      if (executeMatch && method === 'POST') {
        const result = await this.executeJob(executeMatch[1]);
        return this.jsonResponse(result);
      }

      // POST /jobs/:id/retry - Retry a failed job
      const retryMatch = path.match(/^\/jobs\/([^/]+)\/retry$/);
      if (retryMatch && method === 'POST') {
        const result = await this.retryJob(retryMatch[1]);
        return this.jsonResponse(result);
      }

      // POST /jobs/:id/cancel - Cancel a job
      const cancelMatch = path.match(/^\/jobs\/([^/]+)\/cancel$/);
      if (cancelMatch && method === 'POST') {
        const result = await this.cancelJob(cancelMatch[1]);
        return this.jsonResponse(result);
      }

      // DELETE /jobs/:id - Delete a job
      const deleteMatch = path.match(/^\/jobs\/([^/]+)$/);
      if (deleteMatch && method === 'DELETE') {
        const deleted = this.jobs.delete(deleteMatch[1]);
        await this.persist();
        return this.jsonResponse({ deleted });
      }

      return this.jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('[JobCoordinator] Error:', error);
      return this.jsonResponse({
        error: 'Internal error',
        message: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  private async createJob(input: Partial<Job>): Promise<Job> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const job: Job = {
      id,
      type: input.type || 'generic',
      name: input.name || `Job ${id.slice(0, 8)}`,
      description: input.description,
      status: 'pending',
      priority: input.priority || 'normal',
      payload: input.payload || {},
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: input.maxRetries || 3,
      metadata: input.metadata
    };

    this.jobs.set(id, job);
    this.stats.totalJobsCreated++;
    this.updateActivity();
    await this.persist();

    return job;
  }

  private async executeJob(jobId: string): Promise<{ success: boolean; job?: Job; error?: string }> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    if (job.status === 'running') {
      return { success: false, error: 'Job is already running' };
    }

    const startTime = Date.now();
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    this.agentState.status = 'busy';
    this.agentState.currentTask = job.name;
    await this.persist();

    try {
      // Execute the job based on type
      const result = await this.runJobByType(job);

      const duration = Date.now() - startTime;
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      job.result = {
        success: true,
        data: result,
        duration
      };

      this.stats.totalJobsCompleted++;
      this.agentState.stats.tasksCompleted++;
      this.updateAvgDuration(duration);

      await this.persist();
      this.resetAgentState();

      return { success: true, job };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      job.status = 'failed';
      job.updatedAt = new Date().toISOString();
      job.error = {
        code: 'EXECUTION_FAILED',
        message: errorMessage,
        retryable: job.retryCount < job.maxRetries
      };

      this.stats.totalJobsFailed++;
      this.agentState.stats.tasksFailed++;

      await this.persist();
      this.resetAgentState();

      return { success: false, job, error: errorMessage };
    }
  }

  private async runJobByType(job: Job): Promise<unknown> {
    // Job type handlers - extend this for different job types
    switch (job.type) {
      case 'sync':
        return this.handleSyncJob(job);
      case 'analyze':
        return this.handleAnalyzeJob(job);
      case 'resolve':
        return this.handleResolveJob(job);
      case 'generic':
      default:
        return this.handleGenericJob(job);
    }
  }

  private async handleSyncJob(job: Job): Promise<unknown> {
    // Placeholder for sync job execution
    console.log(`[JobCoordinator] Executing sync job: ${job.name}`);
    return { synced: true, timestamp: new Date().toISOString() };
  }

  private async handleAnalyzeJob(job: Job): Promise<unknown> {
    // Placeholder for analyze job execution
    console.log(`[JobCoordinator] Executing analyze job: ${job.name}`);
    return { analyzed: true, timestamp: new Date().toISOString() };
  }

  private async handleResolveJob(job: Job): Promise<unknown> {
    // Placeholder for resolve job execution
    console.log(`[JobCoordinator] Executing resolve job: ${job.name}`);
    return { resolved: true, timestamp: new Date().toISOString() };
  }

  private async handleGenericJob(job: Job): Promise<unknown> {
    // Generic job just logs and returns
    console.log(`[JobCoordinator] Executing generic job: ${job.name}`);
    return { executed: true, timestamp: new Date().toISOString() };
  }

  private async retryJob(jobId: string): Promise<{ success: boolean; job?: Job; error?: string }> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    if (job.status !== 'failed') {
      return { success: false, error: 'Job is not in failed state' };
    }

    if (job.retryCount >= job.maxRetries) {
      return { success: false, error: 'Max retries exceeded' };
    }

    job.retryCount++;
    job.status = 'retrying';
    job.updatedAt = new Date().toISOString();
    job.error = undefined;
    await this.persist();

    // Re-execute the job
    return this.executeJob(jobId);
  }

  private async cancelJob(jobId: string): Promise<{ success: boolean; error?: string }> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    if (job.status === 'completed' || job.status === 'failed') {
      return { success: false, error: 'Cannot cancel a finished job' };
    }

    job.status = 'failed';
    job.updatedAt = new Date().toISOString();
    job.error = {
      code: 'CANCELLED',
      message: 'Job was cancelled',
      retryable: false
    };

    await this.persist();
    return { success: true };
  }

  private updateActivity(): void {
    this.agentState.lastActivity = new Date().toISOString();
  }

  private resetAgentState(): void {
    this.agentState.status = 'idle';
    this.agentState.currentTask = undefined;
    this.updateActivity();
  }

  private updateAvgDuration(newDuration: number): void {
    const completed = this.agentState.stats.tasksCompleted;
    const currentAvg = this.agentState.stats.avgTaskDuration;
    this.agentState.stats.avgTaskDuration =
      (currentAvg * (completed - 1) + newDuration) / completed;
  }

  private jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
