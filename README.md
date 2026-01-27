# ⬛⬜🛣️ Atlas

**Cloudflare Workers Agent Jobs System** - Self-healing, auto-updating agent orchestration for BlackRoad OS.

## Overview

Atlas is a Cloudflare Workers-based system that coordinates agents to:
- **Scrape and sync** BlackRoad OS repositories (including `blackroad-prism-console`)
- **Ensure cohesiveness** across all repos with automated analysis
- **Auto-update** on schedule with configurable intervals
- **Self-resolve** issues when things go wrong (the "somehow lol" approach)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Atlas Worker                              │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────────┐ │
│  │ Hono Router │→ │   Queues    │→ │    Durable Objects       │ │
│  │  (API)      │  │ (async ops) │  │ ┌────────────────────┐   │ │
│  └─────────────┘  └─────────────┘  │ │  JobCoordinator    │   │ │
│                                     │ │  RepoSyncAgent     │   │ │
│  ┌─────────────┐  ┌─────────────┐  │ │  HealthMonitor     │   │ │
│  │    Cron     │→ │   Workers   │→ │ │  CohesivenessCheck │   │ │
│  │ (scheduled) │  │  (handlers) │  │ └────────────────────┘   │ │
│  └─────────────┘  └─────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Features

### Agent Jobs System
- **JobCoordinator**: Manages job lifecycle, scheduling, and execution
- Supports job priorities: `low`, `normal`, `high`, `critical`
- Automatic retries with exponential backoff
- Full job history and status tracking

### Repository Sync
- **RepoSyncAgent**: Monitors and syncs BlackRoad OS repositories
- Automatic discovery of new repos
- File indexing and dependency tracking
- Configurable sync intervals

### Self-Healing
- **HealthMonitor**: Continuously monitors system health
- Automatic issue detection and classification
- Resolution strategies for each issue type:
  - `sync_failure`: Retry, reset, partial sync
  - `job_failure`: Retry, restart with defaults
  - `health_degraded`: Clear cache, restart components
  - `cohesiveness_violation`: Align versions, update references
  - `dependency_mismatch`: Sync dependencies
  - `config_error`: Notify admin (manual intervention)

### Cohesiveness Checker
- **CohesivenessChecker**: Ensures consistency across repos
- Checks performed:
  - Dependency version alignment
  - Naming convention consistency
  - TypeScript config alignment
  - Shared dependencies
  - Cross-repository references
- Generates recommendations and auto-fixes violations

## API Endpoints

### Health & Status
```
GET  /           - System info
GET  /health     - Health status
GET  /api/agents - All agent statuses
```

### Jobs
```
GET  /api/jobs      - List all jobs
POST /api/jobs      - Create a job
GET  /api/jobs/:id  - Get job details
```

### Repository Sync
```
GET  /api/repos      - List monitored repos
POST /api/sync       - Sync all repos
POST /api/sync/:repo - Sync specific repo
```

### Cohesiveness
```
GET  /api/cohesiveness         - Get cohesiveness report
POST /api/cohesiveness/analyze - Run analysis
```

### Self-Resolution
```
POST /api/resolve - Trigger auto-resolution
```

## Scheduled Tasks (Cron)

| Schedule | Task |
|----------|------|
| `*/5 * * * *` | Health check & auto-update |
| `0 * * * *` | Full repository sync |
| `0 0 * * *` | Cohesiveness analysis |

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ENVIRONMENT` | Deployment environment | `development` |
| `LOG_LEVEL` | Logging verbosity | `debug` |
| `SELF_HEAL_ENABLED` | Enable auto-resolution | `true` |
| `AUTO_UPDATE_INTERVAL` | Update check interval (seconds) | `300` |
| `GITHUB_TOKEN` | GitHub API token (optional) | - |

### Cloudflare Bindings

- **Durable Objects**: `JOB_COORDINATOR`, `REPO_SYNC_AGENT`, `HEALTH_MONITOR`, `COHESIVENESS_CHECKER`
- **Queues**: `JOBS_QUEUE`, `SYNC_QUEUE`, `RESOLUTION_QUEUE`
- **KV**: `CACHE`, `REPO_STATE`, `JOB_HISTORY`
- **R2**: `ARTIFACTS`

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Type check
npm run typecheck

# Deploy
npm run deploy
```

## Monitored Repositories

- `BlackRoad-OS/blackroad-prism-console` - Main dashboard and control interface
- `BlackRoad-OS/atlas` - This agent jobs system

Additional repos are automatically discovered and added.

## Self-Resolution Flow

```
Issue Detected → Classify Severity → Select Strategy → Execute Actions → Verify Fix
       ↓                                                       ↓
   Log Issue                                             Retry or Escalate
       ↓                                                       ↓
  Auto-Resolve?  ←──────────────────────────────────────   Success?
       │
       ↓
  Execute Resolution Actions (retry, reset, align, etc.)
```

## License

MIT
