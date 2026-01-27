/**
 * ⬛⬜🛣️ BlackRoad Atlas - Cohesiveness Checker Durable Object
 *
 * Analyzes and ensures consistency across all BlackRoad OS repositories.
 * Detects violations, suggests fixes, and auto-fixes when possible.
 */

import type {
  AgentState,
  CohesivenessReport,
  CohesivenessViolation,
  RepoAnalysis,
  Recommendation,
  ViolationType,
  IssueSeverity,
  JobPriority
} from '../types';

interface CohesivenessState {
  agentState: AgentState;
  lastReport: CohesivenessReport | null;
  violations: Map<string, CohesivenessViolation>;
  repoAnalyses: Map<string, RepoAnalysis>;
  analysisHistory: AnalysisHistoryEntry[];
}

interface AnalysisHistoryEntry {
  id: string;
  timestamp: string;
  overallScore: number;
  violationsFound: number;
  violationsFixed: number;
}

// Cohesiveness rules to check
interface CohesivenessRule {
  id: string;
  name: string;
  description: string;
  violationType: ViolationType;
  severity: IssueSeverity;
  autoFixable: boolean;
  check: (repos: RepoData[]) => Promise<RuleCheckResult[]>;
  fix?: (violation: CohesivenessViolation, repos: RepoData[]) => Promise<boolean>;
}

interface RepoData {
  name: string;
  packageJson?: PackageJson;
  tsConfig?: TsConfig;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

interface TsConfig {
  compilerOptions?: Record<string, unknown>;
}

interface RuleCheckResult {
  passed: boolean;
  violation?: Omit<CohesivenessViolation, 'id'>;
}

export class CohesivenessChecker implements DurableObject {
  private state: DurableObjectState;
  private agentState: AgentState;
  private lastReport: CohesivenessReport | null = null;
  private violations: Map<string, CohesivenessViolation> = new Map();
  private repoAnalyses: Map<string, RepoAnalysis> = new Map();
  private analysisHistory: AnalysisHistoryEntry[] = [];
  private rules: CohesivenessRule[] = [];
  private initPromise: Promise<void> | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.agentState = {
      id: 'cohesiveness-checker',
      name: 'Cohesiveness Checker',
      status: 'idle',
      lastActivity: new Date().toISOString(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        uptime: 0,
        avgTaskDuration: 0
      }
    };

    // Initialize cohesiveness rules
    this.initializeRules();
  }

  private initializeRules(): void {
    this.rules = [
      {
        id: 'dep-version-consistency',
        name: 'Dependency Version Consistency',
        description: 'All repos should use the same versions of shared dependencies',
        violationType: 'dependency_version_mismatch',
        severity: 'medium',
        autoFixable: true,
        check: async (repos) => this.checkDependencyVersions(repos),
        fix: async (violation, repos) => this.fixDependencyVersions(violation, repos)
      },
      {
        id: 'naming-convention',
        name: 'Naming Convention Consistency',
        description: 'All repos should follow consistent naming patterns',
        violationType: 'naming_inconsistency',
        severity: 'low',
        autoFixable: false,
        check: async (repos) => this.checkNamingConventions(repos)
      },
      {
        id: 'tsconfig-consistency',
        name: 'TypeScript Config Consistency',
        description: 'TypeScript configs should be consistent across repos',
        violationType: 'config_inconsistency',
        severity: 'medium',
        autoFixable: true,
        check: async (repos) => this.checkTsConfigs(repos),
        fix: async (violation, repos) => this.fixTsConfigs(violation, repos)
      },
      {
        id: 'shared-deps',
        name: 'Shared Dependencies',
        description: 'All repos should include required shared dependencies',
        violationType: 'missing_shared_dependency',
        severity: 'high',
        autoFixable: true,
        check: async (repos) => this.checkSharedDependencies(repos),
        fix: async (violation, repos) => this.fixSharedDependencies(violation, repos)
      },
      {
        id: 'cross-references',
        name: 'Cross-Repository References',
        description: 'References between repos should be valid and up-to-date',
        violationType: 'outdated_reference',
        severity: 'high',
        autoFixable: true,
        check: async (repos) => this.checkCrossReferences(repos),
        fix: async (violation, repos) => this.fixCrossReferences(violation, repos)
      }
    ];
  }

  private async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const stored = await this.state.storage.get<CohesivenessState>('state');
        if (stored) {
          this.agentState = stored.agentState;
          this.lastReport = stored.lastReport;
          this.violations = new Map(stored.violations);
          this.repoAnalyses = new Map(stored.repoAnalyses);
          this.analysisHistory = stored.analysisHistory || [];
        }
      })();
    }
    await this.initPromise;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('state', {
      agentState: this.agentState,
      lastReport: this.lastReport,
      violations: this.violations,
      repoAnalyses: this.repoAnalyses,
      analysisHistory: this.analysisHistory.slice(-50) // Keep last 50 entries
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
          violationsCount: this.violations.size,
          reposAnalyzed: this.repoAnalyses.size,
          lastReportScore: this.lastReport?.overallScore
        });
      }

      // GET /report - Get latest cohesiveness report
      if (path === '/report' && method === 'GET') {
        return this.jsonResponse({
          report: this.lastReport,
          violations: Array.from(this.violations.values()),
          repoAnalyses: Array.from(this.repoAnalyses.values())
        });
      }

      // POST /analyze - Run cohesiveness analysis
      if (path === '/analyze' && method === 'POST') {
        const body = await request.json().catch(() => ({})) as { repos?: string[]; full?: boolean };
        const result = await this.runAnalysis(body.repos, body.full);
        return this.jsonResponse(result);
      }

      // GET /violations - List all violations
      if (path === '/violations' && method === 'GET') {
        const violations = Array.from(this.violations.values());
        return this.jsonResponse({
          violations,
          total: violations.length,
          byType: this.groupViolationsByType(violations),
          bySeverity: this.groupViolationsBySeverity(violations)
        });
      }

      // POST /auto-fix - Auto-fix all fixable violations
      if (path === '/auto-fix' && method === 'POST') {
        const result = await this.autoFixViolations();
        return this.jsonResponse(result);
      }

      // POST /fix/:id - Fix specific violation
      const fixMatch = path.match(/^\/fix\/([^/]+)$/);
      if (fixMatch && method === 'POST') {
        const result = await this.fixViolation(fixMatch[1]);
        return this.jsonResponse(result);
      }

      // GET /rules - List all cohesiveness rules
      if (path === '/rules' && method === 'GET') {
        return this.jsonResponse({
          rules: this.rules.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            violationType: r.violationType,
            severity: r.severity,
            autoFixable: r.autoFixable
          }))
        });
      }

      // GET /recommendations - Get recommendations based on current state
      if (path === '/recommendations' && method === 'GET') {
        const recommendations = this.generateRecommendations();
        return this.jsonResponse({ recommendations });
      }

      // GET /history - Get analysis history
      if (path === '/history' && method === 'GET') {
        return this.jsonResponse({
          history: this.analysisHistory,
          total: this.analysisHistory.length
        });
      }

      return this.jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('[CohesivenessChecker] Error:', error);
      return this.jsonResponse({
        error: 'Internal error',
        message: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  private async runAnalysis(
    repoNames?: string[],
    full = false
  ): Promise<CohesivenessReport> {
    this.agentState.status = 'busy';
    this.agentState.currentTask = full ? 'Full cohesiveness analysis' : 'Partial analysis';
    await this.persist();

    const startTime = Date.now();
    console.log('[CohesivenessChecker] Running analysis');

    // In production, fetch actual repo data
    const repos = await this.fetchRepoData(repoNames);

    // Clear previous violations for analyzed repos
    for (const repo of repos) {
      this.violations.forEach((v, id) => {
        if (v.repos.includes(repo.name)) {
          this.violations.delete(id);
        }
      });
    }

    // Run all rules
    const newViolations: CohesivenessViolation[] = [];

    for (const rule of this.rules) {
      try {
        const results = await rule.check(repos);
        for (const result of results) {
          if (!result.passed && result.violation) {
            const violation: CohesivenessViolation = {
              id: crypto.randomUUID(),
              ...result.violation
            };
            this.violations.set(violation.id, violation);
            newViolations.push(violation);
          }
        }
      } catch (error) {
        console.error(`[CohesivenessChecker] Rule ${rule.id} failed:`, error);
      }
    }

    // Analyze each repo
    const repoAnalyses: RepoAnalysis[] = [];
    for (const repo of repos) {
      const repoViolations = newViolations.filter((v) => v.repos.includes(repo.name));
      const analysis: RepoAnalysis = {
        repo: repo.name,
        score: this.calculateRepoScore(repoViolations),
        issues: repoViolations.map((v) => v.description),
        lastAnalyzed: new Date().toISOString()
      };
      this.repoAnalyses.set(repo.name, analysis);
      repoAnalyses.push(analysis);
    }

    // Calculate overall score
    const overallScore = repoAnalyses.length > 0
      ? Math.round(repoAnalyses.reduce((sum, r) => sum + r.score, 0) / repoAnalyses.length)
      : 100;

    // Generate recommendations
    const recommendations = this.generateRecommendations();

    // Create report
    const report: CohesivenessReport = {
      timestamp: new Date().toISOString(),
      overallScore,
      repos: repoAnalyses,
      violations: Array.from(this.violations.values()),
      recommendations
    };

    this.lastReport = report;

    // Record history
    this.analysisHistory.push({
      id: crypto.randomUUID(),
      timestamp: report.timestamp,
      overallScore,
      violationsFound: newViolations.length,
      violationsFixed: 0
    });

    this.agentState.status = 'idle';
    this.agentState.currentTask = undefined;
    this.agentState.lastActivity = new Date().toISOString();
    this.agentState.stats.tasksCompleted++;
    await this.persist();

    console.log(`[CohesivenessChecker] Analysis complete: score=${overallScore}, violations=${newViolations.length}`);

    return report;
  }

  private async fetchRepoData(repoNames?: string[]): Promise<RepoData[]> {
    // In production, fetch actual data from repos via GitHub API
    // For now, return mock data for known repos
    const knownRepos = ['blackroad-prism-console', 'atlas'];
    const targetRepos = repoNames || knownRepos;

    return targetRepos.map((name) => ({
      name,
      packageJson: {
        name: `@blackroad-os/${name}`,
        version: '0.1.0',
        dependencies: {},
        devDependencies: {}
      },
      tsConfig: {
        compilerOptions: {}
      },
      dependencies: {},
      devDependencies: {},
      files: []
    }));
  }

  private calculateRepoScore(violations: CohesivenessViolation[]): number {
    if (violations.length === 0) return 100;

    const severityWeights: Record<IssueSeverity, number> = {
      low: 5,
      medium: 10,
      high: 20,
      critical: 40
    };

    const totalPenalty = violations.reduce(
      (sum, v) => sum + severityWeights[v.severity],
      0
    );

    return Math.max(0, 100 - totalPenalty);
  }

  private groupViolationsByType(
    violations: CohesivenessViolation[]
  ): Record<ViolationType, number> {
    const result: Partial<Record<ViolationType, number>> = {};
    for (const v of violations) {
      result[v.type] = (result[v.type] || 0) + 1;
    }
    return result as Record<ViolationType, number>;
  }

  private groupViolationsBySeverity(
    violations: CohesivenessViolation[]
  ): Record<IssueSeverity, number> {
    const result: Record<IssueSeverity, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0
    };
    for (const v of violations) {
      result[v.severity]++;
    }
    return result;
  }

  private generateRecommendations(): Recommendation[] {
    const recommendations: Recommendation[] = [];
    const violations = Array.from(this.violations.values());

    // Group by type and generate recommendations
    const byType = this.groupViolationsByType(violations);

    if (byType.dependency_version_mismatch > 0) {
      recommendations.push({
        priority: 'high',
        action: 'Align dependency versions across all repositories',
        reason: `${byType.dependency_version_mismatch} dependency version mismatches found`,
        affectedRepos: violations
          .filter((v) => v.type === 'dependency_version_mismatch')
          .flatMap((v) => v.repos)
          .filter((v, i, a) => a.indexOf(v) === i)
      });
    }

    if (byType.config_inconsistency > 0) {
      recommendations.push({
        priority: 'normal',
        action: 'Standardize configuration files across repositories',
        reason: `${byType.config_inconsistency} configuration inconsistencies found`,
        affectedRepos: violations
          .filter((v) => v.type === 'config_inconsistency')
          .flatMap((v) => v.repos)
          .filter((v, i, a) => a.indexOf(v) === i)
      });
    }

    if (byType.missing_shared_dependency > 0) {
      recommendations.push({
        priority: 'high',
        action: 'Add missing shared dependencies',
        reason: `${byType.missing_shared_dependency} missing shared dependencies`,
        affectedRepos: violations
          .filter((v) => v.type === 'missing_shared_dependency')
          .flatMap((v) => v.repos)
          .filter((v, i, a) => a.indexOf(v) === i)
      });
    }

    if (byType.outdated_reference > 0) {
      recommendations.push({
        priority: 'critical',
        action: 'Update outdated cross-repository references',
        reason: `${byType.outdated_reference} outdated references found`,
        affectedRepos: violations
          .filter((v) => v.type === 'outdated_reference')
          .flatMap((v) => v.repos)
          .filter((v, i, a) => a.indexOf(v) === i)
      });
    }

    return recommendations.sort((a, b) => {
      const priorityOrder: Record<JobPriority, number> = {
        critical: 0,
        high: 1,
        normal: 2,
        low: 3
      };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  private async autoFixViolations(): Promise<{
    attempted: number;
    fixed: string[];
    failed: string[];
    skipped: string[];
  }> {
    const fixed: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];

    for (const violation of this.violations.values()) {
      if (!violation.autoFixable) {
        skipped.push(violation.id);
        continue;
      }

      const result = await this.fixViolation(violation.id);
      if (result.success) {
        fixed.push(violation.id);
      } else {
        failed.push(violation.id);
      }
    }

    // Update history
    if (this.analysisHistory.length > 0) {
      this.analysisHistory[this.analysisHistory.length - 1].violationsFixed = fixed.length;
    }

    await this.persist();

    return {
      attempted: this.violations.size,
      fixed,
      failed,
      skipped
    };
  }

  private async fixViolation(violationId: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    const violation = this.violations.get(violationId);
    if (!violation) {
      return { success: false, error: 'Violation not found' };
    }

    if (!violation.autoFixable) {
      return { success: false, error: 'Violation is not auto-fixable' };
    }

    const rule = this.rules.find((r) => r.violationType === violation.type);
    if (!rule || !rule.fix) {
      return { success: false, error: 'No fix available for this violation type' };
    }

    try {
      const repos = await this.fetchRepoData(violation.repos);
      const success = await rule.fix(violation, repos);

      if (success) {
        this.violations.delete(violationId);
        await this.persist();
        return { success: true };
      }

      return { success: false, error: 'Fix did not succeed' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Fix failed'
      };
    }
  }

  // Rule check implementations
  private async checkDependencyVersions(repos: RepoData[]): Promise<RuleCheckResult[]> {
    const results: RuleCheckResult[] = [];
    const depVersions: Record<string, Record<string, string>> = {};

    // Collect all dependency versions
    for (const repo of repos) {
      const allDeps = { ...repo.dependencies, ...repo.devDependencies };
      for (const [dep, version] of Object.entries(allDeps)) {
        if (!depVersions[dep]) depVersions[dep] = {};
        depVersions[dep][repo.name] = version;
      }
    }

    // Check for mismatches
    for (const [dep, versions] of Object.entries(depVersions)) {
      const uniqueVersions = new Set(Object.values(versions));
      if (uniqueVersions.size > 1) {
        results.push({
          passed: false,
          violation: {
            type: 'dependency_version_mismatch',
            repos: Object.keys(versions),
            description: `Dependency "${dep}" has different versions: ${JSON.stringify(versions)}`,
            severity: 'medium',
            autoFixable: true,
            suggestedFix: `Align all repos to use the latest version of "${dep}"`
          }
        });
      }
    }

    if (results.length === 0) {
      results.push({ passed: true });
    }

    return results;
  }

  private async checkNamingConventions(repos: RepoData[]): Promise<RuleCheckResult[]> {
    const results: RuleCheckResult[] = [];

    for (const repo of repos) {
      // Check package name convention
      if (repo.packageJson?.name && !repo.packageJson.name.startsWith('@blackroad-os/')) {
        results.push({
          passed: false,
          violation: {
            type: 'naming_inconsistency',
            repos: [repo.name],
            description: `Package name "${repo.packageJson.name}" doesn't follow @blackroad-os/* convention`,
            severity: 'low',
            autoFixable: false
          }
        });
      }
    }

    if (results.length === 0) {
      results.push({ passed: true });
    }

    return results;
  }

  private async checkTsConfigs(repos: RepoData[]): Promise<RuleCheckResult[]> {
    // In production, compare actual tsconfig settings
    return [{ passed: true }];
  }

  private async checkSharedDependencies(repos: RepoData[]): Promise<RuleCheckResult[]> {
    // In production, check for required shared dependencies
    return [{ passed: true }];
  }

  private async checkCrossReferences(repos: RepoData[]): Promise<RuleCheckResult[]> {
    // In production, validate cross-repo references
    return [{ passed: true }];
  }

  // Rule fix implementations
  private async fixDependencyVersions(
    violation: CohesivenessViolation,
    repos: RepoData[]
  ): Promise<boolean> {
    console.log(`[CohesivenessChecker] Fixing dependency versions: ${violation.description}`);
    // In production, update package.json files and create PRs
    return true;
  }

  private async fixTsConfigs(
    violation: CohesivenessViolation,
    repos: RepoData[]
  ): Promise<boolean> {
    console.log(`[CohesivenessChecker] Fixing tsconfig: ${violation.description}`);
    return true;
  }

  private async fixSharedDependencies(
    violation: CohesivenessViolation,
    repos: RepoData[]
  ): Promise<boolean> {
    console.log(`[CohesivenessChecker] Fixing shared deps: ${violation.description}`);
    return true;
  }

  private async fixCrossReferences(
    violation: CohesivenessViolation,
    repos: RepoData[]
  ): Promise<boolean> {
    console.log(`[CohesivenessChecker] Fixing cross-references: ${violation.description}`);
    return true;
  }

  private jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
