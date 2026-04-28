import * as vscode from 'vscode';
import { PRRef, PRAnalysis, PRAction } from '../types';
import {
  listOpenPRs, fetchPRData, approvePR, requestChanges,
  commentOnPR, mergePR, closePR,
} from '../utils/github-client';
import { SYSTEM_PR_REVIEW, buildPRReviewPrompt, prSummaryMd } from '../utils/prompts';

// ─── Session state ────────────────────────────────────────────────────────────

interface ReviewSession {
  queue: PRRef[];           // PRs queued for review
  currentIndex: number;
  analyses: Map<number, PRAnalysis>;
  awaitingAction?: PRRef;
}

const sessions = new Map<string, ReviewSession>();

function getSession(id: string): ReviewSession {
  if (!sessions.has(id)) {
    sessions.set(id, { queue: [], currentIndex: 0, analyses: new Map() });
  }
  return sessions.get(id)!;
}

// ─── LLM helper ───────────────────────────────────────────────────────────────

async function callLLM(
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
  prompt: string,
): Promise<string> {
  const msgs = [vscode.LanguageModelChatMessage.User(SYSTEM_PR_REVIEW + '\n\n' + prompt)];
  const resp = await request.model.sendRequest(msgs, {}, token);
  let out = '';
  for await (const chunk of resp.text) out += chunk;
  return out.trim();
}

function parseJSON<T>(raw: string): T | null {
  const clean = raw.replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim();
  try { return JSON.parse(clean) as T; } catch { return null; }
}

// ─── Risk helpers ─────────────────────────────────────────────────────────────

function riskFromPatterns(patterns: Array<{ severity: 'high' | 'critical' }>): PRAnalysis['riskLevel'] {
  if (patterns.some(p => p.severity === 'critical')) return 'critical';
  if (patterns.some(p => p.severity === 'high')) return 'high';
  return 'low'; // LLM will refine this
}

function canAutoMerge(analysis: PRAnalysis): boolean {
  return analysis.riskLevel === 'low' && analysis.harmfulPatterns.length === 0;
}

// ─── Full analysis of one PR ──────────────────────────────────────────────────

async function analysePR(
  pr: PRRef,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
  stream: vscode.ChatResponseStream,
): Promise<PRAnalysis> {
  stream.progress(`Fetching diff for #${pr.number} ${pr.title}…`);

  const { diff, filesChanged, additions, deletions, harmfulPatterns, files } =
    await fetchPRData(pr);

  // Static risk floor from pattern scanner
  const staticRisk = riskFromPatterns(harmfulPatterns);

  // LLM review (trimmed diff for token efficiency)
  stream.progress(`Analysing #${pr.number} with AI…`);
  const prBody = ''; // could fetch from API if needed
  const raw = await callLLM(
    request, token,
    buildPRReviewPrompt(pr.title, prBody, diff),
  );

  const llmResult = parseJSON<{
    summary: string;
    riskLevel: PRAnalysis['riskLevel'];
    harmfulPatterns: string[];
    recommendation: PRAnalysis['recommendation'];
    highlights: string[];
  }>(raw);

  // Merge static + LLM findings; take the higher risk level
  const riskOrder = ['low', 'medium', 'high', 'critical'];
  const mergedRisk = riskOrder.indexOf(staticRisk) > riskOrder.indexOf(llmResult?.riskLevel ?? 'low')
    ? staticRisk
    : (llmResult?.riskLevel ?? staticRisk);

  const mergedHarmful = [
    ...harmfulPatterns.map(p => `${p.reason} (${p.severity})`),
    ...(llmResult?.harmfulPatterns ?? []),
  ];

  const analysis: PRAnalysis = {
    pr,
    summary: llmResult?.summary ?? 'Could not generate summary.',
    riskLevel: mergedRisk,
    harmfulPatterns: mergedHarmful,
    filesChanged,
    additions,
    deletions,
    recommendation: mergedHarmful.length ? 'reject' : (llmResult?.recommendation ?? 'needs-review'),
    highlights: [
      `Files changed: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ` +${files.length - 8} more` : ''}`,
      ...(llmResult?.highlights ?? []),
    ],
  };

  return analysis;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function prReviewHandler(
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const state = getSession('default');
  const userText = request.prompt.trim();

  // ── Action on awaiting PR ──────────────────────────────────────────────────
  if (state.awaitingAction) {
    const pr = state.awaitingAction;
    const analysis = state.analyses.get(pr.number);
    const answer = userText.toLowerCase();

    if (answer.startsWith('approve')) {
      if (analysis?.riskLevel === 'critical') {
        stream.markdown(`⛔ Cannot approve a **critical** risk PR. Address the concerns first.\n`);
        return;
      }
      await approvePR(pr.owner, pr.repo, pr.number);
      stream.markdown(`✅ PR #${pr.number} **approved**.\n`);

    } else if (answer.startsWith('reject') || answer.startsWith('close')) {
      const reason = userText.replace(/^(reject|close)\s*/i, '').trim() ||
        'Rejected by reviewer via MultiGit Agent.';
      await requestChanges(pr.owner, pr.repo, pr.number, reason);
      await closePR(pr.owner, pr.repo, pr.number);
      stream.markdown(`❌ PR #${pr.number} **closed** with feedback.\n`);

    } else if (answer.startsWith('merge')) {
      if (!analysis) { stream.markdown('No analysis found for this PR.\n'); return; }
      if (!canAutoMerge(analysis)) {
        stream.markdown(
          `⚠️  Cannot auto-merge: risk level is **${analysis.riskLevel}** ` +
          `with ${analysis.harmfulPatterns.length} concern(s). ` +
          'Approve manually on GitHub or address the issues first.\n'
        );
        return;
      }
      const method = answer.includes('squash') ? 'squash'
                   : answer.includes('rebase') ? 'rebase'
                   : 'squash'; // default
      await mergePR(pr.owner, pr.repo, pr.number, method);
      stream.markdown(`🎉 PR #${pr.number} **merged** (${method}).\n`);

    } else if (answer.startsWith('comment ')) {
      const body = userText.replace(/^comment\s+/i, '').trim();
      await commentOnPR(pr.owner, pr.repo, pr.number, body);
      stream.markdown(`💬 Comment posted on PR #${pr.number}.\n`);

    } else if (answer === 'skip' || answer === 'next') {
      stream.markdown('Skipped.\n');

    } else {
      stream.markdown('Unknown action. Reply: **approve** | **reject** | **merge** | **comment <text>** | **skip**\n');
      return; // keep awaiting
    }

    // Advance to next PR in queue
    state.awaitingAction = undefined;
    state.currentIndex++;

    if (state.currentIndex < state.queue.length) {
      const next = state.queue[state.currentIndex];
      stream.markdown(`\n---\nNext PR (#${next.number}): **${next.title}**\nAnalysing…\n`);
      const nextAnalysis = await analysePR(next, request, token, stream);
      state.analyses.set(next.number, nextAnalysis);
      state.awaitingAction = next;
      stream.markdown(prSummaryMd({ ...nextAnalysis, ...nextAnalysis.pr }));
    } else {
      stream.markdown('\n✅ All queued PRs reviewed.\n');
      state.queue = [];
      state.currentIndex = 0;
    }
    return;
  }

  // ── Parse new review request ───────────────────────────────────────────────

  // Try to extract owner/repo from prompt: "review PRs in myorg/myrepo"
  const repoMatch = userText.match(/(?:in|for|repo)\s+([\w.-]+\/[\w.-]+)/i);
  const orgMatch  = userText.match(/(?:in|for|org)\s+([\w.-]+)/i);
  const prNumMatch = userText.match(/#?(\d+)/);

  const defaultOrg = vscode.workspace.getConfiguration('multigitAgent').get<string>('defaultOrg', '');

  let prsToReview: PRRef[] = [];

  if (repoMatch) {
    const [owner, repo] = repoMatch[1].split('/');
    if (prNumMatch) {
      // Single PR
      prsToReview = [{
        owner, repo,
        number: parseInt(prNumMatch[1]),
        title: `PR #${prNumMatch[1]}`,
        headBranch: '', baseBranch: '',
        author: '', url: `https://github.com/${owner}/${repo}/pull/${prNumMatch[1]}`,
      }];
    } else {
      stream.progress(`Listing open PRs in ${owner}/${repo}…`);
      prsToReview = await listOpenPRs(owner, repo);
    }
  } else if (orgMatch || defaultOrg) {
    stream.markdown(
      '⚠️  Org-wide PR listing requires specifying a repo. ' +
      'Use: `@prreview review PRs in owner/repo`\n'
    );
    return;
  } else {
    stream.markdown(
      'Please specify a repo: `@prreview review PRs in owner/repo`\n' +
      'Or a single PR: `@prreview review #42 in owner/repo`\n'
    );
    return;
  }

  if (!prsToReview.length) {
    stream.markdown('✅ No open PRs found.\n');
    return;
  }

  stream.markdown(`Found **${prsToReview.length}** open PR(s). Starting review…\n\n`);

  state.queue = prsToReview;
  state.currentIndex = 0;
  state.analyses.clear();

  // Start with first PR
  const first = prsToReview[0];
  const analysis = await analysePR(first, request, token, stream);
  state.analyses.set(first.number, analysis);
  state.awaitingAction = first;

  stream.markdown(prSummaryMd({ ...analysis, ...analysis.pr }));
}
