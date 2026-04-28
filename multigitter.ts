import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RepoRef, RunResult } from '../types';

const execFileAsync = promisify(execFile);

function cfg<T>(key: string): T {
  return vscode.workspace.getConfiguration('multigitAgent').get<T>(key) as T;
}

// ─── Repo resolution ──────────────────────────────────────────────────────────

/**
 * Resolves a pattern (org name, owner/repo, or search string) to a list of
 * RepoRef objects using `gh repo list` / `gh search repos`.
 * Capped at 100 for safety.
 */
export async function resolveRepos(pattern: string): Promise<RepoRef[]> {
  const token = cfg<string>('githubToken');
  const env = token
    ? { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token }
    : process.env;

  let stdout: string;

  // If it looks like owner/repo exactly → single repo
  if (/^[\w.-]+\/[\w.-]+$/.test(pattern.trim())) {
    const [owner, name] = pattern.trim().split('/');
    return [{ owner, name, fullName: `${owner}/${name}` }];
  }

  // If it looks like an org name → list repos in org
  if (/^[\w.-]+$/.test(pattern.trim())) {
    try {
      ({ stdout } = await execFileAsync('gh', [
        'repo', 'list', pattern.trim(),
        '--json', 'nameWithOwner',
        '--limit', '100',
      ], { env }));
      const items = JSON.parse(stdout) as Array<{ nameWithOwner: string }>;
      return items.map(r => {
        const [owner, name] = r.nameWithOwner.split('/');
        return { owner, name, fullName: r.nameWithOwner };
      });
    } catch { /* fall through to search */ }
  }

  // Otherwise treat as a search query
  ({ stdout } = await execFileAsync('gh', [
    'search', 'repos', pattern.trim(),
    '--json', 'fullName',
    '--limit', '100',
  ], { env }));
  const items = JSON.parse(stdout) as Array<{ fullName: string }>;
  return items.map(r => {
    const [owner, name] = r.fullName.split('/');
    return { owner, name, fullName: r.fullName };
  });
}

// ─── Script execution via multi-gitter ───────────────────────────────────────

export interface MultiGitterOptions {
  repos: RepoRef[];
  script: string;
  flags?: string[];
  dryRun?: boolean;
  branch?: string;
  commitMsg?: string;
  prTitle?: string;
  prBody?: string;
}

/**
 * Writes the script to a temp file and invokes multi-gitter run.
 * Returns per-repo results.
 */
export async function runMultiGitter(opts: MultiGitterOptions): Promise<RunResult[]> {
  const bin = cfg<string>('multigitterPath') || 'multi-gitter';
  const token = cfg<string>('githubToken');
  const env = token
    ? { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token }
    : process.env;

  // Write script to temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multigit-'));
  const scriptPath = path.join(tmpDir, 'script.sh');
  fs.writeFileSync(scriptPath, opts.script, { mode: 0o755 });

  const repoArgs = opts.repos.flatMap(r => ['--repo', r.fullName]);

  const args: string[] = [
    'run', scriptPath,
    ...repoArgs,
    ...(opts.branch        ? ['--branch', opts.branch]            : []),
    ...(opts.commitMsg     ? ['--commit-message', opts.commitMsg]  : []),
    ...(opts.prTitle       ? ['--pr-title', opts.prTitle]          : []),
    ...(opts.prBody        ? ['--pr-body', opts.prBody]            : []),
    ...(opts.dryRun        ? ['--dry-run']                         : []),
    ...(opts.flags ?? []),
    '--output', 'json',
  ];

  return new Promise((resolve) => {
    const results: RunResult[] = [];
    const proc = spawn(bin, args, { env });

    let buf = '';
    proc.stdout.on('data', (d: Buffer) => { buf += d.toString(); });

    proc.stderr.on('data', (d: Buffer) => {
      // multi-gitter streams JSON lines to stderr as well
      buf += d.toString();
    });

    proc.on('close', () => {
      // Parse JSON-lines output
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          results.push({
            repo: parsed.repo ?? parsed.repository ?? '?',
            success: parsed.status === 'success' || parsed.success === true,
            output: parsed.output ?? parsed.message ?? '',
            error: parsed.error ?? undefined,
          });
        } catch {
          // Non-JSON line – attach to last result or create generic
          if (results.length) {
            results[results.length - 1].output += '\n' + line;
          }
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve(results);
    });
  });
}

/**
 * Runs `multi-gitter create-pull-request` for repos that already have
 * a prepared branch (e.g. after a script run without --pr).
 */
export async function createPRs(opts: {
  repos: RepoRef[];
  branch: string;
  title: string;
  body: string;
  flags?: string[];
}): Promise<RunResult[]> {
  const bin = cfg<string>('multigitterPath') || 'multi-gitter';
  const token = cfg<string>('githubToken');
  const env = token ? { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token } : process.env;

  const repoArgs = opts.repos.flatMap(r => ['--repo', r.fullName]);
  const args = [
    'create-pull-request',
    ...repoArgs,
    '--branch', opts.branch,
    '--pr-title', opts.title,
    '--pr-body', opts.body,
    ...(opts.flags ?? []),
    '--output', 'json',
  ];

  return new Promise((resolve) => {
    let buf = '';
    const proc = spawn(bin, args, { env });
    proc.stdout.on('data', (d: Buffer) => { buf += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { buf += d.toString(); });
    proc.on('close', () => {
      const results: RunResult[] = buf.split('\n')
        .filter(l => l.trim())
        .flatMap(line => {
          try {
            const p = JSON.parse(line);
            return [{ repo: p.repo ?? '?', success: !p.error, output: p.output ?? line, error: p.error }];
          } catch { return []; }
        });
      resolve(results);
    });
  });
}

/** Returns multi-gitter version string for diagnostics */
export async function getVersion(): Promise<string> {
  const bin = cfg<string>('multigitterPath') || 'multi-gitter';
  try {
    const { stdout } = await execFileAsync(bin, ['--version']);
    return stdout.trim();
  } catch {
    return '(not found – check multigitAgent.multigitterPath)';
  }
}
