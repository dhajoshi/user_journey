import { SafetyResult } from '../types';

// ─── Danger patterns ──────────────────────────────────────────────────────────

/** Patterns that are ALWAYS blocked (no sanitisation possible) */
const HARD_BLOCK: Array<{ re: RegExp; reason: string }> = [
  { re: /gh\s+repo\s+delete/i,        reason: 'Deletes a GitHub repository' },
  { re: /gh\s+repo\s+archive/i,       reason: 'Archives a GitHub repository' },
  { re: /git\s+push\s+.*--force(?!-with-lease)/i, reason: 'Force-push without lease (data loss risk)' },
  { re: /rm\s+-rf\s+\//i,             reason: 'Recursive delete from filesystem root' },
  { re: /:\s*>\s*\/etc\//i,           reason: 'Overwrites system file' },
  { re: /chmod\s+777/i,               reason: 'Removes all file permissions restrictions' },
  { re: /curl.*\|\s*(ba)?sh/i,        reason: 'Remote code execution via pipe' },
  { re: /wget.*\|\s*(ba)?sh/i,        reason: 'Remote code execution via pipe' },
  { re: /git\s+config\s+--global/i,   reason: 'Modifies global git config' },
  { re: /git\s+remote\s+set-url/i,    reason: 'Changes remote URL' },
  { re: /gh\s+repo\s+transfer/i,      reason: 'Transfers repository ownership' },
  { re: /gh\s+repo\s+rename/i,        reason: 'Renames repository' },
];

/** Patterns that are stripped/warned but don't block the whole run */
const SOFT_WARN: Array<{ re: RegExp; reason: string }> = [
  { re: /git\s+push\s+.*--force-with-lease/i, reason: 'Force-push with lease (verify this is intentional)' },
  { re: /git\s+branch\s+-[Dd]/i,              reason: 'Deletes a git branch' },
  { re: /git\s+tag\s+-d/i,                    reason: 'Deletes a git tag' },
  { re: /git\s+reset\s+--hard/i,              reason: 'Hard reset (discards working tree)' },
  { re: /git\s+clean\s+-f/i,                  reason: 'Removes untracked files' },
  { re: /gh\s+secret\s+set/i,                 reason: 'Sets a GitHub secret' },
  { re: /gh\s+variable\s+set/i,               reason: 'Sets a GitHub variable' },
  { re: /GITHUB_TOKEN/i,                       reason: 'References GitHub token (verify not leaked)' },
];

// ─── PR diff harm checks ──────────────────────────────────────────────────────

const PR_HARMFUL: Array<{ re: RegExp; reason: string; severity: 'high' | 'critical' }> = [
  { re: /\.github\/workflows\//i,   reason: 'Modifies CI/CD workflows', severity: 'high' },
  { re: /CODEOWNERS/i,              reason: 'Modifies CODEOWNERS', severity: 'high' },
  { re: /\.github\/SECURITY/i,      reason: 'Modifies security policy', severity: 'high' },
  { re: /secrets?\s*[:=]/i,         reason: 'Possible secret in diff', severity: 'critical' },
  { re: /password\s*[:=]/i,         reason: 'Possible password in diff', severity: 'critical' },
  { re: /private_key/i,             reason: 'Possible private key in diff', severity: 'critical' },
  { re: /-----BEGIN\s+\w+\s+KEY/i, reason: 'PEM key material in diff', severity: 'critical' },
  { re: /rm\s+-rf/i,                reason: 'Recursive delete in script change', severity: 'high' },
  { re: /DROP\s+TABLE/i,            reason: 'SQL DROP TABLE in change', severity: 'high' },
  { re: /eval\(/i,                  reason: 'eval() usage (code injection risk)', severity: 'high' },
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Checks a script/command string for dangerous patterns.
 * Returns SafetyResult with safe=false if hard-blocked, or
 * safe=true with issues[] listing soft warnings.
 */
export function checkScript(script: string): SafetyResult {
  const issues: string[] = [];

  // Hard blocks – full stop
  for (const { re, reason } of HARD_BLOCK) {
    if (re.test(script)) {
      issues.push(`🚫 BLOCKED: ${reason}`);
    }
  }
  if (issues.length) {
    return { safe: false, issues };
  }

  // Soft warnings – strip offending lines, continue with cleaned script
  const lines = script.split('\n');
  const sanitisedLines: string[] = [];

  for (const line of lines) {
    let stripped = false;
    for (const { re, reason } of SOFT_WARN) {
      if (re.test(line)) {
        issues.push(`⚠️  STRIPPED: ${reason} → \`${line.trim()}\``);
        stripped = true;
        break;
      }
    }
    if (!stripped) sanitisedLines.push(line);
  }

  return {
    safe: true,
    issues,
    sanitised: sanitisedLines.join('\n'),
  };
}

/**
 * Checks a PR diff string for harmful patterns.
 * Returns list of { reason, severity } findings.
 */
export function checkPRDiff(diff: string): Array<{ reason: string; severity: 'high' | 'critical' }> {
  return PR_HARMFUL
    .filter(({ re }) => re.test(diff))
    .map(({ reason, severity }) => ({ reason, severity }));
}

/**
 * Checks multi-gitter flags for dangerous options.
 */
export function checkFlags(flags: string[]): string[] {
  const issues: string[] = [];
  const joined = flags.join(' ');

  if (/--skip-pr/i.test(joined) && /--merge/i.test(joined)) {
    issues.push('⚠️  --skip-pr with --merge is ambiguous');
  }
  if (/--interactive=false/i.test(joined)) {
    issues.push('⚠️  Non-interactive mode skips confirmations');
  }
  return issues;
}
