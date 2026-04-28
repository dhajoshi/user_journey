"""
Safety checker for shell scripts and PR diffs.
Blocks dangerous operations before they reach multi-gitter or GitHub.
"""

import re
from dataclasses import dataclass
from typing import Optional

# ── Patterns that must NEVER run ─────────────────────────────────────────────
BLOCKED: list[tuple[str, str]] = [
    # Repo destruction
    (r"gh repo delete",                         "repo deletion"),
    (r"git remote remove\s+origin",             "removing origin remote"),
    (r"--delete.*--repo|--repo.*--delete",      "repo deletion flag combo"),

    # Repo archiving
    (r"gh repo archive",                        "repo archiving"),
    (r'"archived"\s*:\s*true',                  "archiving via API"),

    # Branch protection / git config tampering
    (r"git config\s+--global",                  "global git config change"),
    (r"gh api.*branch_protection.*DELETE",       "deleting branch protection"),
    (r"gh api.*rulesets.*DELETE",               "deleting rulesets"),
    (r"git push.*--force(?!-with-lease)",        "force push without lease"),
    (r"git push.*-f\b",                         "force push shorthand"),

    # Secrets / credential exposure
    (r"cat\s+~?/?\.ssh/",                       "reading SSH keys"),
    (r"echo.*GITHUB_TOKEN",                     "echoing GitHub token"),
    (r"printenv.*TOKEN|TOKEN.*printenv",        "printing token env var"),

    # Mass file removal
    (r"rm\s+-rf\s+/",                           "recursive root removal"),
    (r"find\s+\.\s+.*-delete",                  "find-delete sweep"),

    # Webhook / org settings
    (r"gh api.*orgs/.*/hooks.*DELETE",          "deleting org webhooks"),
    (r"gh api.*orgs/.*/settings",               "modifying org settings"),
]

# ── Patterns that raise a warning (need explicit user OK) ────────────────────
WARN: list[tuple[str, str]] = [
    (r"git push.*--force-with-lease",           "force-push-with-lease"),
    (r"git rebase",                             "rebase (rewrites history)"),
    (r"git reset\s+--hard",                     "hard reset"),
    (r"chmod\s+777",                            "world-writable permissions"),
    (r"curl\s+.*\|\s*(?:ba)?sh",               "curl-pipe-to-shell"),
    (r"wget\s+.*-O\s*-\s*\|",                  "wget-pipe-to-shell"),
    (r"npm\s+publish",                          "publishing to npm"),
    (r"pypi|twine upload",                      "publishing to PyPI"),
]


@dataclass
class SafetyResult:
    safe: bool
    blocked: list[str]
    warnings: list[str]

    def summary(self) -> str:
        lines = []
        if self.blocked:
            lines.append("🚫 BLOCKED operations detected:")
            lines.extend(f"  • {b}" for b in self.blocked)
        if self.warnings:
            lines.append("⚠️  Operations requiring confirmation:")
            lines.extend(f"  • {w}" for w in self.warnings)
        if self.safe and not self.warnings:
            lines.append("✅ No dangerous patterns found.")
        return "\n".join(lines)


def check_script(script: str) -> SafetyResult:
    """Scan a shell script for dangerous patterns."""
    blocked, warnings = [], []
    text = script.lower()

    for pattern, label in BLOCKED:
        if re.search(pattern, text, re.I):
            blocked.append(label)

    for pattern, label in WARN:
        if re.search(pattern, text, re.I):
            warnings.append(label)

    return SafetyResult(safe=len(blocked) == 0, blocked=blocked, warnings=warnings)


def check_pr_diff(diff: str) -> SafetyResult:
    """
    Scan a PR diff for changes that look dangerous.
    Focuses on CI/CD, workflow, and config files.
    """
    blocked, warnings = [], []

    # Workflow files being deleted
    if re.search(r"^-{3} a/\.github/workflows/", diff, re.M):
        if re.search(r"^deleted file mode", diff, re.M):
            blocked.append("deleting GitHub Actions workflow file")

    # Hardcoded secrets patterns in added lines
    added = "\n".join(
        l[1:] for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++")
    )
    secret_patterns = [
        (r"(?i)(password|passwd|secret|token|api_key)\s*=\s*['\"][^'\"]{8,}", "hardcoded credential"),
        (r"[A-Za-z0-9+/]{40,}={0,2}",                                          "possible base64 secret"),
        (r"ghp_[A-Za-z0-9]{36}",                                               "GitHub PAT in diff"),
        (r"AKIA[A-Z0-9]{16}",                                                  "AWS access key"),
    ]
    for pattern, label in secret_patterns:
        if re.search(pattern, added):
            blocked.append(label)

    # Dangerous workflow changes
    if ".github/workflows" in diff:
        if re.search(r"pull_request_target", added):
            warnings.append("pull_request_target trigger (privilege escalation risk)")
        if re.search(r"run:.*curl.*\|.*sh", added):
            warnings.append("curl-pipe-to-shell in workflow")

    # CODEOWNERS removal
    if re.search(r"^deleted file.*CODEOWNERS", diff, re.M | re.I):
        warnings.append("CODEOWNERS file deleted")

    return SafetyResult(safe=len(blocked) == 0, blocked=blocked, warnings=warnings)


def pick_subset(repos: list[str], n: int = 3) -> list[str]:
    """Return first N repos for trial run, sorted for determinism."""
    return sorted(repos)[:n]
