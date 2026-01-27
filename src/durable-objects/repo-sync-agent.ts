/**
 * ⬛⬜🛣️ BlackRoad Atlas - Repo Sync Agent Durable Object
 *
 * Handles repository scraping, synchronization, and monitoring.
 * Tracks blackroad-prism-console and other BlackRoad OS repos.
 */

import type { Repository, RepoSyncStatus, AgentState, BLACKROAD_REPOS } from '../types';

interface RepoSyncState {
  repos: Map<string, Repository>;
  agentState: AgentState;
  lastFullSync: string | null;
  syncHistory: SyncHistoryEntry[];
}

interface SyncHistoryEntry {
  id: string;
  repo: string;
  status: 'success' | 'failed';
  timestamp: string;
  duration: number;
  changes?: number;
  error?: string;
}

// Default BlackRoad repos to monitor
const DEFAULT_REPOS: Repository[] = [
  {
    name: 'blackroad-prism-console',
    fullName: 'BlackRoad-OS/blackroad-prism-console',
    url: 'https://github.com/BlackRoad-OS/blackroad-prism-console',
    defaultBranch: 'main',
    description: 'BlackRoad Prism Console - Main dashboard and control interface',
    status: 'unknown'
  },
  {
    name: 'atlas',
    fullName: 'BlackRoad-OS/atlas',
    url: 'https://github.com/BlackRoad-OS/atlas',
    defaultBranch: 'main',
    description: 'Atlas - Cloudflare Workers Agent Jobs System',
    status: 'unknown'
  }
];

export class RepoSyncAgent implements DurableObject {
  private state: DurableObjectState;
  private repos: Map<string, Repository> = new Map();
  private agentState: AgentState;
  private lastFullSync: string | null = null;
  private syncHistory: SyncHistoryEntry[] = [];
  private initPromise: Promise<void> | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.agentState = {
      id: 'repo-sync-agent',
      name: 'Repository Sync Agent',
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
        const stored = await this.state.storage.get<RepoSyncState>('state');
        if (stored) {
          this.repos = new Map(stored.repos);
          this.agentState = stored.agentState;
          this.lastFullSync = stored.lastFullSync;
          this.syncHistory = stored.syncHistory || [];
        } else {
          // Initialize with default repos
          for (const repo of DEFAULT_REPOS) {
            this.repos.set(repo.name, repo);
          }
          await this.persist();
        }
      })();
    }
    await this.initPromise;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('state', {
      repos: this.repos,
      agentState: this.agentState,
      lastFullSync: this.lastFullSync,
      syncHistory: this.syncHistory.slice(-100) // Keep last 100 entries
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
          repoCount: this.repos.size,
          lastFullSync: this.lastFullSync
        });
      }

      // GET /repos - List all repos
      if (path === '/repos' && method === 'GET') {
        const repos = Array.from(this.repos.values());
        return this.jsonResponse({
          repos,
          total: repos.length,
          lastFullSync: this.lastFullSync
        });
      }

      // POST /repos - Add a new repo to monitor
      if (path === '/repos' && method === 'POST') {
        const body = await request.json() as Partial<Repository>;
        const repo = await this.addRepo(body);
        return this.jsonResponse(repo, 201);
      }

      // GET /repos/:name - Get repo by name
      const repoMatch = path.match(/^\/repos\/([^/]+)$/);
      if (repoMatch && method === 'GET') {
        const repo = this.repos.get(decodeURIComponent(repoMatch[1]));
        if (!repo) {
          return this.jsonResponse({ error: 'Repository not found' }, 404);
        }
        return this.jsonResponse(repo);
      }

      // DELETE /repos/:name - Remove repo from monitoring
      const deleteRepoMatch = path.match(/^\/repos\/([^/]+)$/);
      if (deleteRepoMatch && method === 'DELETE') {
        const deleted = this.repos.delete(decodeURIComponent(deleteRepoMatch[1]));
        await this.persist();
        return this.jsonResponse({ deleted });
      }

      // POST /sync - Sync all repos or specific repos
      if (path === '/sync' && method === 'POST') {
        const body = await request.json() as { repos?: string[]; full?: boolean; force?: boolean };
        const result = await this.syncRepos(body.repos, body.full, body.force);
        return this.jsonResponse(result);
      }

      // POST /sync/:repo - Sync specific repo
      const syncRepoMatch = path.match(/^\/sync\/([^/]+)$/);
      if (syncRepoMatch && method === 'POST') {
        const repoName = decodeURIComponent(syncRepoMatch[1]);
        const body = await request.json().catch(() => ({})) as { force?: boolean };
        const result = await this.syncRepo(repoName, body.force);
        return this.jsonResponse(result);
      }

      // POST /check-updates - Check for updates across all repos
      if (path === '/check-updates' && method === 'POST') {
        const result = await this.checkUpdates();
        return this.jsonResponse(result);
      }

      // GET /history - Get sync history
      if (path === '/history' && method === 'GET') {
        return this.jsonResponse({
          history: this.syncHistory,
          total: this.syncHistory.length
        });
      }

      // POST /discover - Discover additional BlackRoad repos
      if (path === '/discover' && method === 'POST') {
        const result = await this.discoverRepos();
        return this.jsonResponse(result);
      }

      return this.jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('[RepoSyncAgent] Error:', error);
      return this.jsonResponse({
        error: 'Internal error',
        message: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  private async addRepo(input: Partial<Repository>): Promise<Repository> {
    if (!input.name) {
      throw new Error('Repository name is required');
    }

    const repo: Repository = {
      name: input.name,
      fullName: input.fullName || `BlackRoad-OS/${input.name}`,
      url: input.url || `https://github.com/BlackRoad-OS/${input.name}`,
      defaultBranch: input.defaultBranch || 'main',
      description: input.description,
      status: 'unknown'
    };

    this.repos.set(repo.name, repo);
    await this.persist();

    return repo;
  }

  private async syncRepos(
    repoNames?: string[],
    full = false,
    force = false
  ): Promise<{ synced: string[]; failed: string[]; skipped: string[] }> {
    this.agentState.status = 'busy';
    this.agentState.currentTask = full ? 'Full repository sync' : 'Partial repository sync';
    await this.persist();

    const synced: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];

    const reposToSync = repoNames
      ? repoNames.map((name) => this.repos.get(name)).filter(Boolean) as Repository[]
      : Array.from(this.repos.values());

    for (const repo of reposToSync) {
      try {
        // Skip if recently synced (unless forced)
        if (!force && repo.lastSync) {
          const lastSyncTime = new Date(repo.lastSync).getTime();
          const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
          if (lastSyncTime > fiveMinutesAgo) {
            skipped.push(repo.name);
            continue;
          }
        }

        const result = await this.syncRepo(repo.name, force);
        if (result.success) {
          synced.push(repo.name);
        } else {
          failed.push(repo.name);
        }
      } catch (error) {
        failed.push(repo.name);
        console.error(`[RepoSyncAgent] Failed to sync ${repo.name}:`, error);
      }
    }

    if (full) {
      this.lastFullSync = new Date().toISOString();
    }

    this.agentState.status = 'idle';
    this.agentState.currentTask = undefined;
    this.agentState.lastActivity = new Date().toISOString();
    await this.persist();

    return { synced, failed, skipped };
  }

  private async syncRepo(
    repoName: string,
    force = false
  ): Promise<{ success: boolean; repo?: Repository; error?: string }> {
    const repo = this.repos.get(repoName);
    if (!repo) {
      return { success: false, error: 'Repository not found' };
    }

    const startTime = Date.now();
    repo.status = 'syncing';
    await this.persist();

    try {
      // Fetch repo data from GitHub API
      const repoData = await this.fetchRepoData(repo);

      // Update repo with fetched data
      repo.lastSync = new Date().toISOString();
      repo.lastCommit = repoData.lastCommit;
      repo.description = repoData.description || repo.description;
      repo.defaultBranch = repoData.defaultBranch || repo.defaultBranch;
      repo.status = 'synced';

      // Fetch and index files
      const fileIndex = await this.indexRepoFiles(repo);
      repo.files = fileIndex;

      // Fetch dependencies
      const dependencies = await this.fetchRepoDependencies(repo);
      repo.dependencies = dependencies;

      const duration = Date.now() - startTime;

      // Record sync history
      this.recordSyncHistory({
        repo: repoName,
        status: 'success',
        duration,
        changes: fileIndex.totalFiles
      });

      this.agentState.stats.tasksCompleted++;
      await this.persist();

      return { success: true, repo };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      repo.status = 'error';
      repo.lastSync = new Date().toISOString();

      this.recordSyncHistory({
        repo: repoName,
        status: 'failed',
        duration,
        error: errorMessage
      });

      this.agentState.stats.tasksFailed++;
      await this.persist();

      return { success: false, repo, error: errorMessage };
    }
  }

  private async fetchRepoData(repo: Repository): Promise<{
    lastCommit?: string;
    description?: string;
    defaultBranch?: string;
  }> {
    // In production, this would call the GitHub API
    // For now, simulate fetching data
    console.log(`[RepoSyncAgent] Fetching data for ${repo.fullName}`);

    // Simulated response - in production use:
    // const response = await fetch(`https://api.github.com/repos/${repo.fullName}`, {
    //   headers: { Authorization: `token ${GITHUB_TOKEN}` }
    // });
    // const data = await response.json();

    return {
      lastCommit: `sha-${Date.now().toString(36)}`,
      description: repo.description,
      defaultBranch: repo.defaultBranch
    };
  }

  private async indexRepoFiles(repo: Repository): Promise<{
    totalFiles: number;
    byExtension: Record<string, number>;
    lastIndexed: string;
  }> {
    // In production, this would walk the repo tree via GitHub API
    console.log(`[RepoSyncAgent] Indexing files for ${repo.fullName}`);

    // Simulated file index
    return {
      totalFiles: 0,
      byExtension: {},
      lastIndexed: new Date().toISOString()
    };
  }

  private async fetchRepoDependencies(repo: Repository): Promise<Record<string, string>> {
    // In production, fetch package.json and extract dependencies
    console.log(`[RepoSyncAgent] Fetching dependencies for ${repo.fullName}`);

    // Simulated dependencies
    return {};
  }

  private async checkUpdates(): Promise<{
    checked: number;
    updatesAvailable: string[];
    errors: string[];
  }> {
    console.log('[RepoSyncAgent] Checking for updates');

    const updatesAvailable: string[] = [];
    const errors: string[] = [];

    for (const repo of this.repos.values()) {
      try {
        const repoData = await this.fetchRepoData(repo);
        if (repoData.lastCommit && repoData.lastCommit !== repo.lastCommit) {
          updatesAvailable.push(repo.name);
        }
      } catch (error) {
        errors.push(repo.name);
      }
    }

    return {
      checked: this.repos.size,
      updatesAvailable,
      errors
    };
  }

  private async discoverRepos(): Promise<{
    discovered: string[];
    added: string[];
  }> {
    // In production, query GitHub API for BlackRoad-OS organization repos
    console.log('[RepoSyncAgent] Discovering BlackRoad repos');

    // Known repos to discover
    const knownRepos = [
      'blackroad-prism-console',
      'atlas'
      // Add more as they're discovered
    ];

    const discovered: string[] = [];
    const added: string[] = [];

    for (const repoName of knownRepos) {
      if (!this.repos.has(repoName)) {
        discovered.push(repoName);
        await this.addRepo({ name: repoName });
        added.push(repoName);
      }
    }

    return { discovered, added };
  }

  private recordSyncHistory(entry: Omit<SyncHistoryEntry, 'id' | 'timestamp'>): void {
    this.syncHistory.push({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry
    });

    // Keep only last 100 entries
    if (this.syncHistory.length > 100) {
      this.syncHistory = this.syncHistory.slice(-100);
    }
  }

  private jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
