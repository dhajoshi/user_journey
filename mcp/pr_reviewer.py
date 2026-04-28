"""
PR reviewer: fetch PR details, scan diff for risks, approve/reject/merge.
Uses PyGithub. Token from GITHUB_TOKEN env var.
"""

import os
import re
import textwrap
from dataclasses import dataclass
from typing import Optional

from github import Github, GithubException, PullRequest

from .safety import SafetyResult, check_pr_diff

_gh: Optional[Github] = None


def _client() -> Github:
    global _gh
    if _gh is None:
        token = os.environ.get("GITHUB_TOKEN")
        if not token:
            raise RuntimeError("GITHUB_TOKEN env var not set")
        _gh = Github(token, per_page=50)
    return _gh


def _pr_from_url(url: str) -> PullRequest.PullRequest:
    """Parse owner/repo/number from a GitHub PR URL."""
    m = re.search(r"github\.com/([^/]+/[^/]+)/pull/(\d+)", url)
    if not m:
        raise ValueError(f"Cannot parse PR URL: {url}")
    repo = _client().get_repo(m.group(1))
    return repo.get_pull(int(m.group(2)))


def _compact_diff(diff: str, max_chars: int = 6000) -> str:
    """Trim diff to stay within token budget while keeping structure."""
    if len(diff) <= max_chars:
        return diff
    half = max_chars // 2
    trimmed = len(diff) - max_chars
    return diff[:half] + f"\n... [{trimmed} chars trimmed] ...\n" + diff[-half:]


def _file_summary(pr: PullRequest.PullRequest) -> list[dict]:
    """Return compact per-file change summary."""
    return [
        {
            "file": f.filename,
            "status": f.status,
            "+": f.additions,
            "-": f.deletions,
        }
        for f in pr.get_files()
    ]


# ── public API ────────────────────────────────────────────────────────────────

def list_open_prs(repo_name: str, label: Optional[str] = None) -> dict:
    """List open PRs for a repo. Compact output."""
    try:
        repo = _client().get_repo(repo_name)
        prs = repo.get_pulls(state="open", sort="updated", direction="desc")
        items = []
        for pr in prs:
            if label and label not in [lb.name for lb in pr.labels]:
                continue
            items.append({
                "number": pr.number,
                "title": pr.title,
                "author": pr.user.login,
                "branch": pr.head.ref,
                "url": pr.html_url,
                "draft": pr.draft,
                "reviews": pr.get_reviews().totalCount,
                "checks": pr.mergeable_state,
            })
        return {"ok": True, "count": len(items), "prs": items}
    except GithubException as e:
        return {"ok": False, "error": str(e)}


def get_pr_details(pr_url: str) -> dict:
    """
    Fetch PR metadata + compact diff + safety scan.
    This is the 'preview' step before any action.
    """
    try:
        pr = _pr_from_url(pr_url)
        raw_diff = pr._requester.requestMemoizedAndCheck(    # noqa: SLF001
            "GET", pr.url, headers={"Accept": "application/vnd.github.v3.diff"}
        )[1]

        safety: SafetyResult = check_pr_diff(raw_diff)
        files = _file_summary(pr)

        # Compact commit list
        commits = [
            {"sha": c.sha[:8], "msg": c.commit.message.splitlines()[0][:80]}
            for c in pr.get_commits()
        ]

        return {
            "ok": True,
            "number": pr.number,
            "title": pr.title,
            "author": pr.user.login,
            "base": pr.base.ref,
            "head": pr.head.ref,
            "body": (pr.body or "")[:500],
            "draft": pr.draft,
            "mergeable": pr.mergeable,
            "mergeable_state": pr.mergeable_state,
            "files_changed": len(files),
            "files": files,
            "commits": commits,
            "diff_preview": _compact_diff(raw_diff),
            "safety": {
                "safe": safety.safe,
                "blocked": safety.blocked,
                "warnings": safety.warnings,
                "summary": safety.summary(),
            },
        }
    except GithubException as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def approve_pr(pr_url: str, comment: str = "LGTM ✅") -> dict:
    """Approve a PR. Blocked if safety check found issues."""
    try:
        pr = _pr_from_url(pr_url)
        # Quick safety check on diff before approving
        raw_diff = pr._requester.requestMemoizedAndCheck(   # noqa: SLF001
            "GET", pr.url, headers={"Accept": "application/vnd.github.v3.diff"}
        )[1]
        safety = check_pr_diff(raw_diff)
        if not safety.safe:
            return {
                "ok": False,
                "error": "Cannot approve — safety check failed",
                "safety": safety.summary(),
            }

        pr.create_review(body=comment, event="APPROVE")
        return {"ok": True, "action": "approved", "pr": pr.number}
    except GithubException as e:
        return {"ok": False, "error": str(e)}


def request_changes(pr_url: str, comment: str) -> dict:
    """Request changes on a PR (soft reject)."""
    try:
        pr = _pr_from_url(pr_url)
        pr.create_review(body=comment, event="REQUEST_CHANGES")
        return {"ok": True, "action": "changes_requested", "pr": pr.number}
    except GithubException as e:
        return {"ok": False, "error": str(e)}


def close_pr(pr_url: str, comment: Optional[str] = None) -> dict:
    """Close (reject) a PR without merging."""
    try:
        pr = _pr_from_url(pr_url)
        if comment:
            pr.create_issue_comment(comment)
        pr.edit(state="closed")
        return {"ok": True, "action": "closed", "pr": pr.number}
    except GithubException as e:
        return {"ok": False, "error": str(e)}


def merge_pr(
    pr_url: str,
    merge_method: str = "squash",  # merge | squash | rebase
    commit_title: Optional[str] = None,
    commit_message: Optional[str] = None,
) -> dict:
    """
    Merge a PR — only if safety passes AND PR is mergeable.
    Returns a preview dict first; actual merge is a separate confirmed call.
    merge_method: squash (default, cleaner history) | merge | rebase
    """
    try:
        pr = _pr_from_url(pr_url)

        if pr.draft:
            return {"ok": False, "error": "PR is still a draft"}
        if pr.merged:
            return {"ok": False, "error": "PR already merged"}
        if not pr.mergeable:
            return {"ok": False, "error": f"PR not mergeable (state: {pr.mergeable_state})"}

        # Safety gate
        raw_diff = pr._requester.requestMemoizedAndCheck(   # noqa: SLF001
            "GET", pr.url, headers={"Accept": "application/vnd.github.v3.diff"}
        )[1]
        safety = check_pr_diff(raw_diff)
        if not safety.safe:
            return {
                "ok": False,
                "error": "Merge blocked — safety check failed",
                "safety": safety.summary(),
            }

        kwargs: dict = {"merge_method": merge_method}
        if commit_title:
            kwargs["commit_title"] = commit_title
        if commit_message:
            kwargs["commit_message"] = commit_message

        result = pr.merge(**kwargs)
        return {
            "ok": result.merged,
            "action": "merged",
            "sha": result.sha,
            "message": result.message,
            "pr": pr.number,
            "method": merge_method,
        }
    except GithubException as e:
        return {"ok": False, "error": str(e)}


def add_comment(pr_url: str, body: str) -> dict:
    """Post a comment on a PR."""
    try:
        pr = _pr_from_url(pr_url)
        comment = pr.create_issue_comment(body)
        return {"ok": True, "comment_id": comment.id}
    except GithubException as e:
        return {"ok": False, "error": str(e)}
