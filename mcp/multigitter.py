"""
multi-gitter runner: generate, validate, dry-run, and execute scripts
across GitHub repos using the multi-gitter CLI.
"""

import json
import os
import shlex
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from .safety import SafetyResult, check_script, pick_subset

MULTIGITTER = os.getenv("MULTIGITTER_BIN", "multi-gitter")


# ── helpers ──────────────────────────────────────────────────────────────────

def _run(cmd: list[str], timeout: int = 120) -> tuple[int, str, str]:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def _write_script(content: str) -> Path:
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".sh", delete=False, prefix="mg_"
    )
    tmp.write(content)
    tmp.flush()
    Path(tmp.name).chmod(0o755)
    return Path(tmp.name)


def _build_target_flags(
    org: Optional[str],
    repos: Optional[list[str]],
    base_branch: Optional[str],
) -> list[str]:
    flags = []
    if org:
        flags += ["--org", org]
    if repos:
        for r in repos:
            flags += ["--repo", r]
    if base_branch:
        flags += ["--base-branch", base_branch]
    return flags


def _compact_output(stdout: str, max_lines: int = 60) -> str:
    """Trim noisy output to stay token-efficient."""
    lines = stdout.splitlines()
    if len(lines) <= max_lines:
        return stdout
    half = max_lines // 2
    trimmed = len(lines) - max_lines
    return "\n".join(
        lines[:half]
        + [f"... [{trimmed} lines trimmed] ..."]
        + lines[-half:]
    )


# ── public API ────────────────────────────────────────────────────────────────

def validate_script(script: str) -> dict:
    """
    Check a shell script for dangerous patterns.
    Returns safety result as a dict.
    """
    result: SafetyResult = check_script(script)
    return {
        "safe": result.safe,
        "blocked": result.blocked,
        "warnings": result.warnings,
        "summary": result.summary(),
    }


def dry_run(
    script: str,
    org: Optional[str] = None,
    repos: Optional[list[str]] = None,
    base_branch: Optional[str] = None,
    subset_size: int = 3,
) -> dict:
    """
    Run multi-gitter in PRINT mode (no changes made).
    Always targets a small subset of repos.
    Returns stdout/stderr and safety check.
    """
    safety = check_script(script)
    if not safety.safe:
        return {
            "ok": False,
            "error": "Script blocked by safety checker",
            "safety": safety.summary(),
        }

    # Enforce subset
    target_repos = repos or []
    subset = pick_subset(target_repos, subset_size) if target_repos else []

    script_path = _write_script(script)
    try:
        cmd = [MULTIGITTER, "print"]
        cmd += _build_target_flags(org, subset or None, base_branch)
        cmd += [str(script_path)]

        code, out, err = _run(cmd)
        return {
            "ok": code == 0,
            "mode": "dry-run (print)",
            "repos_targeted": subset or (["--org scope"] if org else []),
            "stdout": _compact_output(out),
            "stderr": err[:2000] if err else "",
            "safety_warnings": safety.warnings,
        }
    finally:
        script_path.unlink(missing_ok=True)


def run_script(
    script: str,
    pr_title: str,
    commit_message: str,
    org: Optional[str] = None,
    repos: Optional[list[str]] = None,
    base_branch: Optional[str] = None,
    feature_branch: Optional[str] = None,
    pr_body: Optional[str] = None,
    reviewers: Optional[list[str]] = None,
    labels: Optional[list[str]] = None,
    subset_size: int = 3,
    skip_pr: bool = False,
) -> dict:
    """
    Execute script via multi-gitter run, creating commits/PRs.
    Always targets subset first. Raises error if safety blocked.
    """
    safety = check_script(script)
    if not safety.safe:
        return {
            "ok": False,
            "error": "Script blocked by safety checker",
            "safety": safety.summary(),
        }

    target_repos = repos or []
    subset = pick_subset(target_repos, subset_size) if target_repos else []

    script_path = _write_script(script)
    try:
        cmd = [MULTIGITTER, "run"]
        cmd += _build_target_flags(org, subset or None, base_branch)
        cmd += ["--pr-title", pr_title, "--commit-message", commit_message]

        if feature_branch:
            cmd += ["--branch", feature_branch]
        if pr_body:
            cmd += ["--pr-body", pr_body]
        if reviewers:
            for rv in reviewers:
                cmd += ["--reviewers", rv]
        if labels:
            for lb in labels:
                cmd += ["--labels", lb]
        if skip_pr:
            cmd += ["--skip-pr"]

        cmd += [str(script_path)]

        code, out, err = _run(cmd, timeout=300)
        return {
            "ok": code == 0,
            "mode": "run (live)",
            "repos_targeted": subset or (["--org scope"] if org else []),
            "stdout": _compact_output(out),
            "stderr": err[:2000] if err else "",
            "safety_warnings": safety.warnings,
        }
    finally:
        script_path.unlink(missing_ok=True)


def list_prs(
    org: Optional[str] = None,
    repos: Optional[list[str]] = None,
    base_branch: Optional[str] = None,
    branch: Optional[str] = None,
) -> dict:
    """List open PRs created by multi-gitter."""
    cmd = [MULTIGITTER, "status"]
    cmd += _build_target_flags(org, repos, base_branch)
    if branch:
        cmd += ["--branch", branch]

    code, out, err = _run(cmd)
    return {
        "ok": code == 0,
        "output": _compact_output(out, max_lines=80),
        "stderr": err[:1000] if err else "",
    }


def close_prs(
    org: Optional[str] = None,
    repos: Optional[list[str]] = None,
    branch: Optional[str] = None,
) -> dict:
    """Close PRs opened by multi-gitter (cleanup)."""
    if not branch:
        return {"ok": False, "error": "branch name required to close PRs safely"}
    cmd = [MULTIGITTER, "close"]
    cmd += _build_target_flags(org, repos, None)
    cmd += ["--branch", branch]

    code, out, err = _run(cmd)
    return {"ok": code == 0, "output": out[:2000], "stderr": err[:500]}


def merge_prs(
    org: Optional[str] = None,
    repos: Optional[list[str]] = None,
    branch: Optional[str] = None,
    merge_type: str = "merge",  # merge | squash | rebase
) -> dict:
    """Merge PRs opened by multi-gitter."""
    if not branch:
        return {"ok": False, "error": "branch name required"}
    cmd = [MULTIGITTER, "merge"]
    cmd += _build_target_flags(org, repos, None)
    cmd += ["--branch", branch, f"--merge-type={merge_type}"]

    code, out, err = _run(cmd)
    return {"ok": code == 0, "output": out[:2000], "stderr": err[:500]}
