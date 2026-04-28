"""
MCP server for GitHub Copilot in VSCode.
Exposes two agent capabilities:
  • MultiGitter Agent  – generate, validate, dry-run, execute scripts across repos
  • PR Review Agent    – list, review, approve/reject, merge PRs safely

Run:
    python server.py
Configure in .vscode/mcp.json (see project root).
"""

import json
import sys
from typing import Optional

from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(__file__).replace("/server.py", ""))

from tools import multigitter as mg
from tools import pr_reviewer as pr
from tools.safety import pick_subset

mcp = FastMCP(
    "multigitter-agent",
    instructions=(
        "You assist with bulk GitHub repo changes via multi-gitter and with PR review. "
        "ALWAYS dry-run before live execution. ALWAYS target a small repo subset first. "
        "ALWAYS ask user confirmation before any live write operation. "
        "Safety checks run automatically — blocked operations cannot be overridden."
    ),
)

# ═══════════════════════════════════════════════════════════════════════════════
# SCRIPT GENERATION HELPERS (stateless — Copilot generates, we validate)
# ═══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def validate_script(script: str) -> str:
    """
    Validate a shell script for dangerous patterns.
    Call this BEFORE dry_run or run_script.
    Returns JSON with safe/blocked/warnings fields.
    """
    return json.dumps(mg.validate_script(script), indent=2)


# ═══════════════════════════════════════════════════════════════════════════════
# MULTIGITTER — DRY RUN
# ═══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def dry_run_script(
    script: str,
    org: Optional[str] = None,
    repos: Optional[str] = None,         # comma-separated "owner/repo,owner/repo2"
    base_branch: Optional[str] = None,
    subset_size: int = 3,
) -> str:
    """
    DRY-RUN a shell script across repos using 'multi-gitter print'.
    No commits or PRs are created.
    Always limited to `subset_size` repos (default 3).

    Args:
        script: Shell script content to execute
        org: GitHub org name (mutually exclusive with repos)
        repos: Comma-separated list of "owner/repo" strings
        base_branch: Base branch to target (default: repo default branch)
        subset_size: Max repos to target (safety cap, default 3)
    """
    repo_list = [r.strip() for r in repos.split(",") if r.strip()] if repos else []
    result = mg.dry_run(
        script=script,
        org=org,
        repos=repo_list or None,
        base_branch=base_branch,
        subset_size=subset_size,
    )
    return json.dumps(result, indent=2)


# ═══════════════════════════════════════════════════════════════════════════════
# MULTIGITTER — LIVE RUN (requires prior dry-run confirmation)
# ═══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def run_script(
    script: str,
    pr_title: str,
    commit_message: str,
    org: Optional[str] = None,
    repos: Optional[str] = None,
    base_branch: Optional[str] = None,
    feature_branch: Optional[str] = None,
    pr_body: Optional[str] = None,
    reviewers: Optional[str] = None,     # comma-separated GitHub usernames
    labels: Optional[str] = None,        # comma-separated labels
    subset_size: int = 3,
    skip_pr: bool = False,
) -> str:
    """
    LIVE execution via 'multi-gitter run'. Creates commits and PRs.
    ⚠ Only call after dry_run_script was reviewed and user confirmed.
    Always targets subset_size repos (default 3) — run again for more.

    Args:
        script: Shell script to execute
        pr_title: Title for the PR created by multi-gitter
        commit_message: Git commit message
        org: GitHub org name
        repos: Comma-separated "owner/repo" strings
        base_branch: Base branch (default: repo default)
        feature_branch: Branch name multi-gitter will create
        pr_body: Markdown body for the PR description
        reviewers: Comma-separated reviewer GitHub handles
        labels: Comma-separated label names to apply to PRs
        subset_size: Max repos to target in this run (default 3)
        skip_pr: Commit directly without creating a PR
    """
    repo_list = [r.strip() for r in repos.split(",") if r.strip()] if repos else []
    rev_list  = [r.strip() for r in reviewers.split(",") if r.strip()] if reviewers else []
    lbl_list  = [l.strip() for l in labels.split(",") if l.strip()] if labels else []

    result = mg.run_script(
        script=script,
        pr_title=pr_title,
        commit_message=commit_message,
        org=org,
        repos=repo_list or None,
        base_branch=base_branch,
        feature_branch=feature_branch,
        pr_body=pr_body,
        reviewers=rev_list or None,
        labels=lbl_list or None,
        subset_size=subset_size,
        skip_pr=skip_pr,
    )
    return json.dumps(result, indent=2)


@mcp.tool()
def list_multigitter_prs(
    org: Optional[str] = None,
    repos: Optional[str] = None,
    branch: Optional[str] = None,
) -> str:
    """
    List status of PRs created by multi-gitter across repos.

    Args:
        org: GitHub org
        repos: Comma-separated "owner/repo" strings
        branch: Feature branch name to filter by
    """
    repo_list = [r.strip() for r in repos.split(",") if r.strip()] if repos else []
    result = mg.list_prs(org=org, repos=repo_list or None, branch=branch)
    return json.dumps(result, indent=2)


@mcp.tool()
def merge_multigitter_prs(
    branch: str,
    org: Optional[str] = None,
    repos: Optional[str] = None,
    merge_type: str = "squash",
) -> str:
    """
    Merge PRs created by multi-gitter. Requires branch name.
    ⚠ Confirm with user before calling.

    Args:
        branch: Feature branch name (required)
        org: GitHub org
        repos: Comma-separated "owner/repo" strings
        merge_type: merge | squash | rebase (default: squash)
    """
    repo_list = [r.strip() for r in repos.split(",") if r.strip()] if repos else []
    result = mg.merge_prs(org=org, repos=repo_list or None, branch=branch, merge_type=merge_type)
    return json.dumps(result, indent=2)


@mcp.tool()
def close_multigitter_prs(
    branch: str,
    org: Optional[str] = None,
    repos: Optional[str] = None,
) -> str:
    """
    Close (without merging) PRs created by multi-gitter for a branch.
    ⚠ Confirm with user before calling.

    Args:
        branch: Feature branch name (required)
        org: GitHub org
        repos: Comma-separated "owner/repo" strings
    """
    repo_list = [r.strip() for r in repos.split(",") if r.strip()] if repos else []
    result = mg.close_prs(org=org, repos=repo_list or None, branch=branch)
    return json.dumps(result, indent=2)


# ═══════════════════════════════════════════════════════════════════════════════
# PR REVIEW AGENT
# ═══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def list_open_prs(repo: str, label: Optional[str] = None) -> str:
    """
    List open pull requests for a GitHub repo.

    Args:
        repo: "owner/repo" string
        label: Optional label filter
    """
    result = pr.list_open_prs(repo, label=label)
    return json.dumps(result, indent=2)


@mcp.tool()
def review_pr(pr_url: str) -> str:
    """
    Fetch full PR details: metadata, files changed, diff preview, safety scan.
    Call this FIRST before approve/reject/merge.
    Returns compact JSON to minimise token use.

    Args:
        pr_url: Full GitHub PR URL (https://github.com/owner/repo/pull/123)
    """
    result = pr.get_pr_details(pr_url)
    return json.dumps(result, indent=2)


@mcp.tool()
def approve_pr(pr_url: str, comment: str = "LGTM ✅ — approved via automated review.") -> str:
    """
    Approve a pull request. Blocked if safety check detects harmful changes.
    ⚠ Confirm with user before calling.

    Args:
        pr_url: Full GitHub PR URL
        comment: Approval review body
    """
    result = pr.approve_pr(pr_url, comment=comment)
    return json.dumps(result, indent=2)


@mcp.tool()
def request_changes_on_pr(pr_url: str, comment: str) -> str:
    """
    Request changes on a PR (soft reject with feedback).

    Args:
        pr_url: Full GitHub PR URL
        comment: Feedback to the author explaining required changes
    """
    result = pr.request_changes(pr_url, comment=comment)
    return json.dumps(result, indent=2)


@mcp.tool()
def reject_pr(pr_url: str, reason: str) -> str:
    """
    Close (reject) a PR. Posts the reason as a comment before closing.

    Args:
        pr_url: Full GitHub PR URL
        reason: Explanation posted as a comment
    """
    result = pr.close_pr(pr_url, comment=reason)
    return json.dumps(result, indent=2)


@mcp.tool()
def merge_pr(
    pr_url: str,
    merge_method: str = "squash",
    commit_title: Optional[str] = None,
    commit_message: Optional[str] = None,
) -> str:
    """
    Merge a PR after safety check passes.
    ⚠ Always call review_pr first and confirm with user.
    Blocked if PR is draft, not mergeable, or safety check fails.

    Args:
        pr_url: Full GitHub PR URL
        merge_method: squash (default) | merge | rebase
        commit_title: Custom commit title (squash/merge)
        commit_message: Custom commit message body
    """
    result = pr.merge_pr(
        pr_url,
        merge_method=merge_method,
        commit_title=commit_title,
        commit_message=commit_message,
    )
    return json.dumps(result, indent=2)


@mcp.tool()
def comment_on_pr(pr_url: str, body: str) -> str:
    """
    Post a comment on a PR (useful for questions or status updates).

    Args:
        pr_url: Full GitHub PR URL
        body: Markdown comment body
    """
    result = pr.add_comment(pr_url, body)
    return json.dumps(result, indent=2)


# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    mcp.run(transport="stdio")
