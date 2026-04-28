// ─── Token-efficient prompts ──────────────────────────────────────────────────
// Rules: ≤400 token system prompts, structured JSON out, no verbose examples.

export const SYSTEM_MULTIGIT = `You are a multi-gitter CLI expert. Output ONLY valid JSON, no prose.
multi-gitter docs summary:
  run <script>         Execute script across repos
  commit -m <msg>      Commit changes
  create-pull-request  Open PRs
  status               Show status
  Flags: --org, --repo, --search, --branch, --base-branch, --pr-title, --pr-body,
         --reviewers, --labels, --assignees, --merge, --skip-pr, --dry-run, --concurrent
         --author-name, --author-email, --config-file, --token
Danger ops to NEVER generate: repo delete, archive, git config --global, remote set-url, rm -rf /.`;

export const SYSTEM_PR_REVIEW = `You are a security-aware PR reviewer. Output ONLY valid JSON, no prose.
Assess: logic correctness, security (secrets, injections, perms), breaking changes, code quality.
Risk levels: low=safe merge | medium=minor concerns | high=needs author | critical=block merge.`;

// ─── Intent parsing ───────────────────────────────────────────────────────────

export function buildIntentPrompt(userText: string): string {
  return `Parse this instruction into a multi-gitter plan. Return JSON only:
{
  "operation": "script|commit|pr|status",
  "repoPattern": "<org>, <owner/repo>, or search string>",
  "script": "<bash script if operation=script, else null>",
  "flags": ["<multi-gitter flag>"],
  "commitMsg": "<if commit/pr>",
  "prTitle": "<if pr>",
  "prBody": "<if pr, ≤3 sentences>",
  "branch": "<branch name if relevant>"
}
Instruction: ${userText.slice(0, 800)}`;
}

// ─── Script generation ────────────────────────────────────────────────────────

export function buildScriptPrompt(task: string, repoContext: string): string {
  return `Write a safe bash script for: ${task.slice(0, 600)}
Context repos sample: ${repoContext.slice(0, 200)}
Rules: no rm -rf, no force push, no git config --global, no curl|sh.
Return JSON: { "script": "<bash>", "explanation": "<≤2 sentences>" }`;
}

// ─── PR review ────────────────────────────────────────────────────────────────

export function buildPRReviewPrompt(title: string, body: string, diff: string): string {
  // Truncate diff to keep tokens in check – first 3000 chars is usually enough
  const diffSnip = diff.length > 3000
    ? diff.slice(0, 3000) + '\n[...diff truncated for token efficiency...]'
    : diff;

  return `Review this PR and return JSON only:
{
  "summary": "<≤3 sentence plain-english>",
  "riskLevel": "low|medium|high|critical",
  "harmfulPatterns": ["<finding>"],
  "recommendation": "approve|reject|needs-review",
  "highlights": ["<bullet>"]
}
PR Title: ${title}
PR Body: ${body?.slice(0, 300) ?? '(none)'}
Diff:
${diffSnip}`;
}

// ─── Confirmation messages (shown to user, not sent to LLM) ──────────────────

export function planSummaryMd(
  operation: string,
  subset: string[],
  all: string[],
  script: string | undefined,
  flags: string[],
  issues: string[]
): string {
  const lines: string[] = [
    `### 🔍 MultiGit Plan Preview`,
    `**Operation:** \`${operation}\``,
    `**Repos (full set):** ${all.length} repos`,
    `**Preview subset (${subset.length}):** ${subset.join(', ')}`,
  ];
  if (script) lines.push(`\n**Script:**\n\`\`\`bash\n${script}\n\`\`\``);
  if (flags.length) lines.push(`**Flags:** \`${flags.join(' ')}\``);
  if (issues.length) {
    lines.push('\n**⚠️  Safety notes:**');
    issues.forEach(i => lines.push(`- ${i}`));
  }
  lines.push('\n---');
  lines.push('Run on **subset first**? *(Reply **yes**, **no**, or **edit**)*');
  return lines.join('\n');
}

export function prSummaryMd(analysis: {
  title: string; author: string; url: string;
  summary: string; riskLevel: string; harmfulPatterns: string[];
  filesChanged: number; additions: number; deletions: number;
  highlights: string[]; recommendation: string;
}): string {
  const risk = { low: '🟢', medium: '🟡', high: '🔴', critical: '⛔' }[analysis.riskLevel] ?? '❓';
  const lines: string[] = [
    `### ${risk} PR Review: ${analysis.title}`,
    `**Author:** ${analysis.author} | **Risk:** ${analysis.riskLevel.toUpperCase()}`,
    `**Changes:** +${analysis.additions} / -${analysis.deletions} in ${analysis.filesChanged} files`,
    `\n**Summary:** ${analysis.summary}`,
  ];
  if (analysis.highlights.length) {
    lines.push('\n**Highlights:**');
    analysis.highlights.forEach(h => lines.push(`- ${h}`));
  }
  if (analysis.harmfulPatterns.length) {
    lines.push('\n**⚠️  Concerns:**');
    analysis.harmfulPatterns.forEach(p => lines.push(`- ${p}`));
  }
  lines.push(`\n**Recommendation:** ${analysis.recommendation.toUpperCase()}`);
  lines.push(`\n🔗 [View PR](${analysis.url})`);
  lines.push('\n---');
  lines.push('Reply: **approve** | **reject** | **merge** | **comment <text>** | **skip**');
  return lines.join('\n');
}
