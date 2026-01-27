/**
 * ⬛⬜🛣️ BlackRoad Atlas - Type Definitions
 */

// Cloudflare bindings
export interface Env {
  // Durable Objects
  JOB_COORDINATOR: DurableObjectNamespace;
  REPO_SYNC_AGENT: DurableObjectNamespace;
  HEALTH_MONITOR: DurableObjectNamespace;
  COHESIVENESS_CHECKER: DurableObjectNamespace;

  // Queues
  JOBS_QUEUE: Queue<QueueMessage>;
  SYNC_QUEUE: Queue<QueueMessage>;
  RESOLUTION_QUEUE: Queue<QueueMessage>;

  // KV Namespaces
  CACHE: KVNamespace;
  REPO_STATE: KVNamespace;
  JOB_HISTORY: KVNamespace;

  // R2 Bucket
  ARTIFACTS: R2Bucket;

  // Environment variables
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  SELF_HEAL_ENABLED: string;
  AUTO_UPDATE_INTERVAL: string;
  GITHUB_TOKEN?: string;
}

// Queue message types
export type QueueMessageType =
  | 'job:execute'
  | 'job:retry'
  | 'sync:repo'
  | 'sync:all'
  | 'resolve:issue'
  | 'resolve:auto'
  | 'health:check'
  | 'cohesiveness:analyze';

export interface QueueMessage {
  type: QueueMessageType;
  payload: Record<string, unknown>;
  timestamp: string;
  attemptCount?: number;
  correlationId?: string;
}

// Job definitions
export type JobStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'retrying';
export type JobPriority = 'low' | 'normal' | 'high' | 'critical';

export interface Job {
  id: string;
  type: string;
  name: string;
  description?: string;
  status: JobStatus;
  priority: JobPriority;
  payload: Record<string, unknown>;
  result?: JobResult;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: string;
  error?: JobError;
  metadata?: Record<string, unknown>;
}

export interface JobResult {
  success: boolean;
  data?: unknown;
  message?: string;
  duration?: number;
}

export interface JobError {
  code: string;
  message: string;
  stack?: string;
  retryable: boolean;
}

// Repository definitions
export interface Repository {
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  description?: string;
  lastSync?: string;
  lastCommit?: string;
  status: RepoSyncStatus;
  files?: RepoFileIndex;
  dependencies?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export type RepoSyncStatus = 'synced' | 'syncing' | 'stale' | 'error' | 'unknown';

export interface RepoFileIndex {
  totalFiles: number;
  byExtension: Record<string, number>;
  lastIndexed: string;
}

// BlackRoad OS specific repos
export const BLACKROAD_REPOS = [
  'blackroad-prism-console',
  'atlas',
  // Add other BlackRoad repos here as they're discovered
] as const;

export type BlackRoadRepo = typeof BLACKROAD_REPOS[number];

// Health and monitoring
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface HealthCheck {
  component: string;
  status: HealthStatus;
  message?: string;
  lastCheck: string;
  latency?: number;
  metadata?: Record<string, unknown>;
}

export interface Issue {
  id: string;
  type: IssueType;
  severity: IssueSeverity;
  component: string;
  description: string;
  detectedAt: string;
  resolvedAt?: string;
  autoResolvable: boolean;
  resolutionAttempts: number;
  lastAttemptAt?: string;
  resolution?: Resolution;
}

export type IssueType =
  | 'sync_failure'
  | 'job_failure'
  | 'health_degraded'
  | 'cohesiveness_violation'
  | 'dependency_mismatch'
  | 'config_error';

export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface Resolution {
  type: 'auto' | 'manual';
  action: string;
  success: boolean;
  result?: unknown;
  timestamp: string;
}

// Cohesiveness definitions
export interface CohesivenessReport {
  timestamp: string;
  overallScore: number; // 0-100
  repos: RepoAnalysis[];
  violations: CohesivenessViolation[];
  recommendations: Recommendation[];
}

export interface RepoAnalysis {
  repo: string;
  score: number;
  issues: string[];
  lastAnalyzed: string;
}

export interface CohesivenessViolation {
  id: string;
  type: ViolationType;
  repos: string[];
  description: string;
  severity: IssueSeverity;
  autoFixable: boolean;
  suggestedFix?: string;
}

export type ViolationType =
  | 'dependency_version_mismatch'
  | 'naming_inconsistency'
  | 'config_inconsistency'
  | 'missing_shared_dependency'
  | 'outdated_reference'
  | 'broken_link';

export interface Recommendation {
  priority: JobPriority;
  action: string;
  reason: string;
  affectedRepos: string[];
}

// Agent state
export interface AgentState {
  id: string;
  name: string;
  status: 'idle' | 'busy' | 'error';
  lastActivity: string;
  currentTask?: string;
  stats: AgentStats;
}

export interface AgentStats {
  tasksCompleted: number;
  tasksFailed: number;
  uptime: number;
  avgTaskDuration: number;
}

// Utility types
export type Awaitable<T> = T | Promise<T>;

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
  timestamp: string;
}
