import * as vscode from 'vscode';
import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { PRRef, PRAnalysis } from '../types';
import { checkPRDiff } from './safety-checker';

const ThrottledOctokit = Octokit.plugin(throttling);

function getOctokit(): Octokit {
  const token =
    vscode.workspace.getConfiguration('multigitAgent').get<string>('githubToken') ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    '';

  return new ThrottledOctokit({
    auth: token || undefined,
    throttle: {
      onRateLimit: (retryAfter: number, options: { method: string; url: string }) => {
        console.warn(`Rate-limited on ${options.method} ${options.url}. Retrying after ${retryAfter}s`);
        return true;
      },
      onSecondaryRateLimit: (_: number, options: { method: string; url: string }) => {
        console.warn(`Secondary rate-limit on ${options.method} ${options.url}`);
        return false;
      },
    },
  }) as unknown as Octokit;
}

// ─── PR listing ───────────────────────────────────────────────────────────────

/** Lists open PRs for a repo. Returns lightweight PRRef array. */
export async function listOpenPRs(owner: string, repo: string): Promise<PRRef[]> {
  const kit = getOctokit();
  const { data } = await kit.pulls.list({ owner, repo, state: 'open', per_page: 30 });
  return data.map(pr => ({
    owner,
    repo,
    number: pr.number,
    title: pr.title,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    author: pr.user?.login ?? 'unknown',
    url: pr.html_url,
  }));
}

/** Fetches the diff for a PR (truncated at ~200KB for safety). */
export async function getPRDiff(owner: string, repo: string, prNumber: number): Promise<string> {
  const kit = getOctokit();
  const { data } = await kit.pulls.get({
    owner, repo, pull_number: prNumber,
    mediaType: { format: 'diff' },
  });
  const diff = data as unknown as string;
  return typeof diff === 'string' ? diff.slice(0, 200_000) : JSON.stringify(data).slice(0, 200_000);
}

/** Gets file stats for a PR. */
export async function getPRStats(owner: string, repo: string, prNumber: number) {
  const kit = getOctokit();
  const { data } = await kit.pulls.get({ owner, repo, pull_number: prNumber });
  return {
    filesChanged: data.changed_files,
    additions: data.additions,
    deletions: data.deletions,
  };
}

/** Gets list of files changed in a PR */
export async function getPRFiles(owner: string, repo: string, prNumber: number): Promise<string[]> {
  const kit = getOctokit();
  const { data } = await kit.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100 });
  return data.map(f => f.filename);
}

// ─── PR actions ───────────────────────────────────────────────────────────────

export async function approvePR(owner: string, repo: string, prNumber: number): Promise<void> {
  const kit = getOctokit();
  await kit.pulls.createReview({
    owner, repo, pull_number: prNumber,
    event: 'APPROVE',
    body: '✅ Approved by MultiGit Agent after automated safety review.',
  });
}

export async function requestChanges(
  owner: string, repo: string, prNumber: number, body: string
): Promise<void> {
  const kit = getOctokit();
  await kit.pulls.createReview({
    owner, repo, pull_number: prNumber,
    event: 'REQUEST_CHANGES',
    body,
  });
}

export async function commentOnPR(
  owner: string, repo: string, prNumber: number, body: string
): Promise<void> {
  const kit = getOctokit();
  await kit.issues.createComment({ owner, repo, issue_number: prNumber, body });
}

export async function mergePR(
  owner: string, repo: string, prNumber: number,
  method: 'merge' | 'squash' | 'rebase' = 'squash'
): Promise<void> {
  const kit = getOctokit();
  await kit.pulls.merge({
    owner, repo, pull_number: prNumber,
    merge_method: method,
  });
}

export async function closePR(owner: string, repo: string, prNumber: number): Promise<void> {
  const kit = getOctokit();
  await kit.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' });
}

// ─── Safety-enriched fetch ────────────────────────────────────────────────────

/**
 * Fetches diff, stats, and runs local safety checks.
 * Returns partial PRAnalysis (fields that don't need LLM).
 */
export async function fetchPRData(pr: PRRef): Promise<{
  diff: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  harmfulPatterns: Array<{ reason: string; severity: 'high' | 'critical' }>;
  files: string[];
}> {
  const [diff, stats, files] = await Promise.all([
    getPRDiff(pr.owner, pr.repo, pr.number),
    getPRStats(pr.owner, pr.repo, pr.number),
    getPRFiles(pr.owner, pr.repo, pr.number),
  ]);

  const harmfulPatterns = checkPRDiff(diff);

  return { diff, ...stats, harmfulPatterns, files };
}
