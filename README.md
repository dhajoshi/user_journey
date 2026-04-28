# MultiGit Agent for VS Code Copilot Chat

Two AI-powered chat agents for safe, reviewed multi-repository operations.

---

## Agents

### `@multigit` — Multi-Repo Script Runner
Generates and runs scripts across dozens of repos using [multi-gitter](https://github.com/lindell/multi-gitter). Always previews on a small subset first, asks before every step, and blocks dangerous operations.

### `@prreview` — PR Reviewer
Reviews, approves, rejects, or merges Pull Requests. Runs a static safety scan + AI analysis on every diff before asking you what to do. Never merges high/critical risk PRs automatically.

---

## Prerequisites

| Tool | Install |
|------|---------|
| [multi-gitter](https://github.com/lindell/multi-gitter) | `brew install multi-gitter` or [releases](https://github.com/lindell/multi-gitter/releases) |
| [GitHub CLI (`gh`)](https://cli.github.com/) | `brew install gh` then `gh auth login` |
| VS Code 1.90+ with GitHub Copilot Chat | Marketplace |

---

## Installation

```bash
# 1. Clone / copy this repo
git clone <this-repo> && cd multigit-agent

# 2. Install deps
npm install

# 3. Compile
npm run compile

# 4. Package (optional – for sideloading)
npm run package
# → multigit-agent-1.0.0.vsix

# 5. Install the VSIX
code --install-extension multigit-agent-1.0.0.vsix
```

Or press **F5** in VS Code to launch a debug extension host.

---

## Configuration

Set in **Settings → Extensions → MultiGit Agent** or in `settings.json`:

```json
{
  "multigitAgent.githubToken": "",         // PAT or blank (uses gh CLI auth)
  "multigitAgent.defaultOrg": "my-org",    // default GitHub org
  "multigitAgent.subsetSize": 3,           // repos in safety preview (1–10)
  "multigitAgent.multigitterPath": "multi-gitter",
  "multigitAgent.dryRunByDefault": true    // dry-run the subset preview
}
```

**GitHub Token scopes needed:**
- `repo` — read/write repos and PRs
- `read:org` — list org repos

---

## Usage: `@multigit`

### Basic examples

```
@multigit run: Add a CODEOWNERS file to all repos in my-org

@multigit run: Replace Node 16 with Node 20 in all .github/workflows in my-org

@multigit pr: Update the README footer with our new website URL across my-org/service-*

@multigit commit: Remove .DS_Store from all repos in my-org

@multigit status
```

### Workflow

1. **You send** an instruction
2. **Agent parses** intent, resolves repos, generates script
3. **Safety checker** blocks dangerous ops, strips soft-dangerous lines
4. **Agent shows plan** — script, flags, full repo count, subset names
5. **You reply** `yes` / `no` / `edit`
6. **Agent runs on subset** (default: 3 repos, dry-run)
7. **Agent shows results** → asks permission to run on all repos
8. **You reply** `yes` / `no`
9. **Done** ✅

### Safety: what gets blocked

| Pattern | Action |
|---------|--------|
| `gh repo delete` | 🚫 Hard block |
| `gh repo archive` | 🚫 Hard block |
| `git push --force` (no lease) | 🚫 Hard block |
| `rm -rf /` | 🚫 Hard block |
| `git config --global` | 🚫 Hard block |
| `curl \| sh` / `wget \| sh` | 🚫 Hard block |
| `git branch -D` | ⚠️ Line stripped + warned |
| `git reset --hard` | ⚠️ Line stripped + warned |
| `gh secret set` | ⚠️ Line stripped + warned |

---

## Usage: `@prreview`

### Basic examples

```
@prreview review PRs in my-org/my-service

@prreview review #42 in my-org/my-service

@prreview review all open PRs in my-org/frontend
```

### Workflow

1. **Agent fetches** open PRs and the first PR's diff
2. **Static scanner** checks diff for secrets, workflow changes, key material, etc.
3. **AI analysis** produces summary, risk level, highlights
4. **Agent shows preview** — risk, file count, +/- lines, concerns
5. **You reply** one of:
   - `approve` — post an approval review
   - `reject [reason]` — request changes + close
   - `merge` — squash merge (only if risk=low, no harmful patterns)
   - `merge squash` / `merge rebase` — explicit merge method
   - `comment <text>` — post a comment
   - `skip` — move to next PR
6. **Repeat** for each PR in the queue

### Merge safety rules

| Risk Level | Patterns Found | Auto-merge allowed? |
|------------|----------------|---------------------|
| low | none | ✅ Yes (after your `merge` command) |
| medium | any | ❌ No |
| high | any | ❌ No |
| critical | any | ⛔ No (blocked) |

---

## Token efficiency

The agents are designed to minimise LLM token consumption:

- **System prompts ≤ 400 tokens** — just the facts, no examples
- **Diffs truncated at 3 000 chars** for review (full diff used for static scan)
- **JSON-only LLM output** — no prose parsing overhead
- **Static pattern scanner runs first** — reduces how much the LLM needs to infer
- **Session state kept in memory** — no re-sending context on follow-ups

---

## Architecture

```
src/
├── extension.ts              Entry point — registers chat participants
├── types.ts                  Shared interfaces
├── agents/
│   ├── multigit-agent.ts     @multigit handler & session state
│   └── pr-review-agent.ts    @prreview handler & session state
└── utils/
    ├── safety-checker.ts     Pattern-based danger detection (no LLM needed)
    ├── multigitter.ts        multi-gitter CLI wrapper
    ├── github-client.ts      Octokit wrapper for PR ops
    └── prompts.ts            Compact prompt templates & markdown formatters
```

---

## Troubleshooting

**`multi-gitter: command not found`**
→ Set `multigitAgent.multigitterPath` to the full path, e.g. `/usr/local/bin/multi-gitter`

**`gh: command not found` or auth errors**
→ Run `gh auth login` or set `multigitAgent.githubToken` to a PAT

**No repos found**
→ Check `multigitAgent.defaultOrg` and that your token has `read:org` scope

**PR merge blocked**
→ Risk level is medium/high/critical. Review the concerns listed and address them before merging on GitHub directly.

---

## Security notes

- The GitHub token is stored in VS Code settings (use your OS keychain via `gh auth login` for better security)
- Scripts run locally in your terminal via multi-gitter — the extension does **not** send your code to any remote service other than the Copilot LLM
- Diffs sent to the LLM are truncated; secrets found by the static scanner are flagged **before** being sent to the LLM
