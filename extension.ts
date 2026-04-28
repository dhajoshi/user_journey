import * as vscode from 'vscode';
import { multigitHandler } from './agents/multigit-agent';
import { prReviewHandler } from './agents/pr-review-agent';

export function activate(context: vscode.ExtensionContext): void {

  // ─── MultiGit Runner participant ─────────────────────────────────────────
  const runner = vscode.chat.createChatParticipant('multigit.runner', async (
    request, chatContext, stream, token
  ) => {
    try {
      await multigitHandler(request, chatContext, stream, token);
    } catch (err) {
      stream.markdown(`\n\n❌ **Error:** ${String(err)}\n`);
    }
  });

  runner.iconPath = new vscode.ThemeIcon('git-branch');

  // Follow-up suggestions
  runner.followupProvider = {
    provideFollowups(_result, _ctx, _token) {
      return [
        { prompt: 'yes', label: '✅ Yes, proceed', command: '' },
        { prompt: 'no',  label: '❌ No, cancel',   command: '' },
        { prompt: 'status', label: '📊 Show status', command: 'status' },
      ];
    },
  };

  // ─── PR Reviewer participant ─────────────────────────────────────────────
  const reviewer = vscode.chat.createChatParticipant('multigit.reviewer', async (
    request, chatContext, stream, token
  ) => {
    try {
      await prReviewHandler(request, chatContext, stream, token);
    } catch (err) {
      stream.markdown(`\n\n❌ **Error:** ${String(err)}\n`);
    }
  });

  reviewer.iconPath = new vscode.ThemeIcon('git-pull-request');

  reviewer.followupProvider = {
    provideFollowups(_result, _ctx, _token) {
      return [
        { prompt: 'approve', label: '✅ Approve',              command: '' },
        { prompt: 'reject',  label: '❌ Reject',               command: '' },
        { prompt: 'merge',   label: '🎉 Merge (squash)',        command: '' },
        { prompt: 'skip',    label: '⏭️  Skip to next',         command: '' },
      ];
    },
  };

  context.subscriptions.push(runner, reviewer);
}

export function deactivate(): void {}
