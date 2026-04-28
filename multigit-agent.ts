import * as vscode from 'vscode';
import { ParsedIntent, RunPlan, RunResult, RepoRef } from '../types';
import { checkScript, checkFlags } from '../utils/safety-checker';
import { resolveRepos, runMultiGitter, createPRs, getVersion } from '../utils/multigitter';
import {
  SYSTEM_MULTIGIT,
  buildIntentPrompt,
  buildScriptPrompt,
  planSummaryMd,
} from '../utils/prompts';

// ─── State (per session) ──────────────────────────────────────────────────────

interface SessionState {
  pendingPlan?: RunPlan;
  awaitingConfirmation?: 'subset' | 'full';
  lastResults?: RunResult[];
}

const sessions = new Map<string, SessionState>();

function getSession(id: string): SessionState {
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id)!;
}

// ─── LLM helpers ─────────────────────────────────────────────────────────────

async function callLLM(
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const msgs: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n' + userPrompt),
  ];
  const resp = await request.model.sendRequest(msgs, {}, token);
  let out = '';
  for await (const chunk of resp.text) out += chunk;
  return out.trim();
}

function parseJSON<T>(raw: string): T | null {
  const clean = raw.replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim();
  try { return JSON.parse(clean) as T; } catch { return null; }
}

// ─── Core workflow steps ──────────────────────────────────────────────────────

async function resolveIntent(
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
  userText: string,
): Promise<ParsedIntent | null> {
  const raw = await callLLM(request, token, SYSTEM_MULTIGIT, buildIntentPrompt(userText));
  return parseJSON<ParsedIntent>(raw);
}

async function generateScript(
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
  task: string,
  repoSample: string,
): Promise<{ script: string; explanation: string } | null> {
  const raw = await callLLM(
    request, token,
    SYSTEM_MULTIGIT,
    buildScriptPrompt(task, repoSample),
  );
  return parseJSON<{ script: string; explanation: string }>(raw);
}

function pickSubset(all: RepoRef[], size: number): RepoRef[] {
  return all.slice(0, Math.min(size, all.length));
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function multigitHandler(
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('multigitAgent');
  const subsetSize = cfg.get<number>('subsetSize', 3);
  const sessionId = 'default'; // VS Code doesn't expose session ID yet
  const state = getSession(sessionId);
  const userText = request.prompt.trim();

  // ── Special: status ────────────────────────────────────────────────────────
  if (request.command === 'status' || /^\bstatus\b/i.test(userText)) {
    const ver = await getVersion();
    stream.markdown(`**multi-gitter version:** ${ver}\n\n`);
    if (state.lastResults?.length) {
      const ok = state.lastResults.filter(r => r.success).length;
      stream.markdown(`**Last run:** ${ok}/${state.lastResults.length} repos succeeded.\n`);
    } else {
      stream.markdown('No previous run in this session.\n');
    }
    return;
  }

  // ── Confirmation handling ──────────────────────────────────────────────────
  if (state.awaitingConfirmation && state.pendingPlan) {
    const answer = userText.toLowerCase();

    if (answer.startsWith('edit')) {
      stream.markdown('Plan cancelled. Please describe what to change:\n');
      state.awaitingConfirmation = undefined;
      state.pendingPlan = undefined;
      return;
    }

    if (answer === 'no' || answer === 'cancel') {
      stream.markdown('❌ Run cancelled.\n');
      state.awaitingConfirmation = undefined;
      state.pendingPlan = undefined;
      return;
    }

    if (answer === 'yes' || answer.startsWith('y')) {
      const plan = state.pendingPlan;

      if (state.awaitingConfirmation === 'subset') {
        // Run subset first
        stream.markdown(`🔄 Running on **${plan.subsetRepos.length} repos** (dry-run: ${plan.dryRun})…\n\n`);
        const results = await runMultiGitter({
          repos: plan.subsetRepos,
          script: plan.intent.script ?? '#!/bin/bash\necho "no-op"',
          flags: plan.intent.flags,
          dryRun: plan.dryRun,
          branch: plan.intent.branch,
          commitMsg: plan.intent.commitMsg,
          prTitle: plan.intent.prTitle,
          prBody: plan.intent.prBody,
        });

        state.lastResults = results;

        // Show results
        const ok = results.filter(r => r.success).length;
        stream.markdown(`\n**Subset results:** ${ok}/${results.length} succeeded.\n\n`);
        for (const r of results) {
          stream.markdown(`- ${r.success ? '✅' : '❌'} \`${r.repo}\`: ${r.output.slice(0, 120)}\n`);
        }

        if (ok === results.length && plan.allRepos.length > plan.subsetRepos.length) {
          stream.markdown(
            `\n✅ Subset passed. Ready to run on all **${plan.allRepos.length}** repos.\n` +
            'Reply **yes** to continue or **no** to stop.\n'
          );
          state.awaitingConfirmation = 'full';
        } else if (ok < results.length) {
          stream.markdown('\n⚠️  Some subset repos failed. Fix issues before running on all repos.\nRun cancelled.\n');
          state.awaitingConfirmation = undefined;
          state.pendingPlan = undefined;
        } else {
          stream.markdown('\nAll repos in the full set were included in subset. Done.\n');
          state.awaitingConfirmation = undefined;
          state.pendingPlan = undefined;
        }
        return;
      }

      if (state.awaitingConfirmation === 'full') {
        const plan = state.pendingPlan;
        stream.markdown(`🔄 Running on **all ${plan.allRepos.length} repos**…\n\n`);
        const results = await runMultiGitter({
          repos: plan.allRepos,
          script: plan.intent.script ?? '#!/bin/bash\necho "no-op"',
          flags: plan.intent.flags,
          dryRun: false,
          branch: plan.intent.branch,
          commitMsg: plan.intent.commitMsg,
          prTitle: plan.intent.prTitle,
          prBody: plan.intent.prBody,
        });

        state.lastResults = results;
        const ok = results.filter(r => r.success).length;
        stream.markdown(`**Final results:** ${ok}/${results.length} repos succeeded.\n\n`);
        for (const r of results) {
          stream.markdown(`- ${r.success ? '✅' : '❌'} \`${r.repo}\`\n`);
          if (!r.success && r.error) stream.markdown(`  > ${r.error.slice(0, 200)}\n`);
        }

        state.awaitingConfirmation = undefined;
        state.pendingPlan = undefined;
        return;
      }
    }
  }

  // ── Fresh request ──────────────────────────────────────────────────────────
  stream.progress('Parsing your instruction…');

  const intent = await resolveIntent(request, token, userText);
  if (!intent) {
    stream.markdown('❌ Could not parse instruction. Please be more specific.\n');
    return;
  }

  // Generate script if needed and not provided
  if (intent.operation === 'script' && !intent.script) {
    stream.progress('Generating script…');
    const repoHint = intent.repoPattern;
    const gen = await generateScript(request, token, userText, repoHint);
    if (!gen) {
      stream.markdown('❌ Script generation failed. Try rephrasing.\n');
      return;
    }
    intent.script = gen.script;
    stream.markdown(`**Script explanation:** ${gen.explanation}\n\n`);
  }

  // Safety check
  const safetyResult = intent.script ? checkScript(intent.script) : { safe: true, issues: [], sanitised: undefined };
  const flagIssues = checkFlags(intent.flags ?? []);
  const allIssues = [...safetyResult.issues, ...flagIssues];

  if (!safetyResult.safe) {
    stream.markdown('## 🚫 Blocked\n\nThis script contains dangerous operations and cannot run:\n\n');
    allIssues.forEach(i => stream.markdown(`- ${i}\n`));
    stream.markdown('\nPlease revise your instruction to remove the dangerous operations.\n');
    return;
  }

  // Apply sanitised script if lines were stripped
  if (safetyResult.sanitised !== undefined) {
    intent.script = safetyResult.sanitised;
  }

  // Resolve repos
  stream.progress('Resolving repos…');
  let allRepos: RepoRef[] = [];
  try {
    allRepos = await resolveRepos(intent.repoPattern);
  } catch (e) {
    stream.markdown(`❌ Failed to resolve repos for \`${intent.repoPattern}\`: ${String(e)}\n`);
    return;
  }

  if (!allRepos.length) {
    stream.markdown(`❌ No repos found matching \`${intent.repoPattern}\`.\n`);
    return;
  }

  const subsetRepos = pickSubset(allRepos, subsetSize);

  const plan: RunPlan = {
    intent,
    subsetRepos,
    allRepos,
    dryRun: cfg.get<boolean>('dryRunByDefault', true),
  };

  state.pendingPlan = plan;
  state.awaitingConfirmation = 'subset';

  // Show plan summary
  stream.markdown(planSummaryMd(
    intent.operation,
    subsetRepos.map(r => r.fullName),
    allRepos.map(r => r.fullName),
    intent.script,
    intent.flags ?? [],
    allIssues,
  ));
}
