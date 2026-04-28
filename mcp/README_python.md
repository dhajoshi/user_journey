# MultiGitter + PR Review Agent for GitHub Copilot

A Python MCP server that gives GitHub Copilot in VSCode two powerful agents:
- **MultiGitter Agent** — generate scripts, dry-run, then execute bulk changes across repos via PRs
- **PR Review Agent** — list, review, approve/reject, and safely merge PRs

---

## Prerequisites

| Tool | Install |
|------|---------|
| Python 3.11+ | `brew install python` / [python.org](https://python.org) |
| multi-gitter | `brew install lindell/multi-gitter/multi-gitter` |
| GitHub PAT | Settings → Developer settings → PATs (needs `repo`, `read:org`) |
| VSCode Copilot | GitHub Copilot extension with agent/MCP support |

---

## Setup

```bash
# 1. Clone or copy this folder into your project workspace
# 2. Install Python deps
pip install -r requirements.txt

# 3. Export your GitHub token
export GITHUB_TOKEN=ghp_your_token_here

# 4. (Optional) Custom multi-gitter binary path
export MULTIGITTER_BIN=/usr/local/bin/multi-gitter

# 5. Open VSCode — Copilot will auto-load .vscode/mcp.json
```

> The `.vscode/mcp.json` wires the server to Copilot.  
> The `.github/copilot-instructions.md` tells Copilot how to behave safely.

---

## How it works

### Safety layers

```
User prompt
    │
    ▼
[validate_script]  ← regex scan for 30+ dangerous patterns
    │ blocked?  → STOP, tell user, do not proceed
    │
    ▼
[dry_run_script]   ← multi-gitter print (no changes, shows what WOULD change)
    │
    ▼
User confirms
    │
    ▼
[run_script]       ← multi-gitter run (subset of 3 repos by default)
    │
    ▼
User reviews PRs   → expand to more repos if satisfied
```

### Blocked operations (always rejected)

- `gh repo delete` / `gh repo archive`
- Force push without `--force-with-lease`
- `git config --global` changes
- Deleting branch protection rules or rulesets
- Reading SSH keys or printing tokens
- Deleting org webhooks or modifying org settings
- `rm -rf /` style removals

### PR Review flow

```
review_pr(url)          ← fetch metadata + diff + safety scan
    │
    ├── safe?  → approve / request changes / merge options presented
    └── unsafe? → blocked, user must reject or fix
```

---

## Example prompts in Copilot

```
Update .github/dependabot.yml in all repos under org "acme-corp"
to enable weekly npm updates. Run on 3 repos first as trial.
```

```
Review PR https://github.com/acme/api/pull/42 and approve it
if there are no security issues.
```

```
Add a CODEOWNERS file to all repos in org "myorg" with @security-team
as owner of /infra/**. Open PRs, don't merge.
```

```
Merge all open PRs on branch "chore/update-deps" in org "myorg".
```

---

## File structure

```
multigitter-agent/
├── server.py                        # MCP server entry point
├── requirements.txt
├── tools/
│   ├── __init__.py
│   ├── safety.py                    # Dangerous pattern detection
│   ├── multigitter.py               # multi-gitter CLI wrapper
│   └── pr_reviewer.py               # GitHub API PR operations
├── .vscode/
│   └── mcp.json                     # VSCode Copilot MCP config
└── .github/
    └── copilot-instructions.md      # Agent behaviour instructions
```

---

## Security notes

- `GITHUB_TOKEN` is read from environment — never hardcoded
- The safety checker scans both shell scripts AND PR diffs
- PR diffs are scanned for hardcoded secrets (AWS keys, GitHub PATs, etc.)
- `workflow` file changes are flagged for manual review
- The server never stores credentials or state between calls
- All MCP tool outputs are JSON — no shell injection surface
