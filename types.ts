// ─── Shared types ────────────────────────────────────────────────────────────

export interface RepoRef {
  owner: string;
  name: string;
  fullName: string; // owner/name
}

// ── MultiGit ──────────────────────────────────────────────────────────────────

export type OperationType = 'script' | 'commit' | 'pr' | 'status';

export interface ParsedIntent {
  operation: OperationType;
  /** Repos/org/search string from the prompt */
  repoPattern: string;
  /** Raw script body (if operation=script) */
  script?: string;
  /** multi-gitter flags already resolved */
  flags: string[];
  /** Commit message (if operation=commit|pr) */
  commitMsg?: string;
  /** PR title */
  prTitle?: string;
  /** PR body */
  prBody?: string;
  /** Branch name */
  branch?: string;
}

export interface SafetyResult {
  safe: boolean;
  /** Human-readable list of issues found */
  issues: string[];
  /** Sanitised (dangerous lines stripped) version, or undefined if fully blocked */
  sanitised?: string;
}

export interface RunPlan {
  intent: ParsedIntent;
  subsetRepos: RepoRef[];
  allRepos: RepoRef[];
  dryRun: boolean;
}

export interface RunResult {
  repo: string;
  success: boolean;
  output: string;
  error?: string;
}

// ── PR Review ─────────────────────────────────────────────────────────────────

export interface PRRef {
  owner: string;
  repo: string;
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  author: string;
  url: string;
}

export interface PRAnalysis {
  pr: PRRef;
  summary: string;          // ≤3 sentence plain-english summary
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  harmfulPatterns: string[]; // e.g. ["deletes .github/workflows", "modifies CODEOWNERS"]
  filesChanged: number;
  additions: number;
  deletions: number;
  recommendation: 'approve' | 'reject' | 'needs-review';
  highlights: string[];      // bullet points shown to user
}

export type PRAction = 'approve' | 'reject' | 'merge' | 'comment';
