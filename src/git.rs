use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::canonical_or_lexical;

pub fn resolve_git_bin() -> PathBuf {
    if let Ok(explicit) = env::var("OVERLORD_GIT_EXECUTABLE")
        && !explicit.trim().is_empty()
    {
        return PathBuf::from(explicit);
    }
    if let Ok(path_var) = env::var("PATH") {
        for dir in env::split_paths(&path_var) {
            let candidate = dir.join("git");
            if candidate.is_file() {
                return fs::canonicalize(&candidate).unwrap_or(candidate);
            }
        }
    }
    PathBuf::from("git")
}

fn git_cmd(repo_dir: &Path) -> Command {
    let mut cmd = Command::new(resolve_git_bin());
    cmd.current_dir(repo_dir);
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
    ] {
        cmd.env_remove(key);
    }
    cmd
}

pub fn validate_dedicated_repo(agents_dir: &Path) -> Result<(), String> {
    let dot_git = agents_dir.join(".git");
    let meta = fs::symlink_metadata(&dot_git).map_err(|_| {
        format!(
            "Dedicated Git repository missing at {} (run 'overlord init' first).",
            agents_dir.display()
        )
    })?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!(
            "{} must be a physical directory, not a worktree file or symlink.",
            dot_git.display()
        ));
    }

    let out = git_cmd(agents_dir)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("Failed to invoke git in {}: {e}", agents_dir.display()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "Invalid Git repository at {}: {}",
            agents_dir.display(),
            stderr.trim()
        ));
    }
    let toplevel = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    if canonical_or_lexical(&toplevel) != canonical_or_lexical(agents_dir) {
        return Err(format!(
            "Git work-tree top-level ({}) does not match {}.",
            toplevel.display(),
            agents_dir.display()
        ));
    }
    Ok(())
}

pub fn init_or_validate_repo(agents_dir: &Path) -> Result<(), String> {
    let dot_git = agents_dir.join(".git");
    if fs::symlink_metadata(&dot_git).is_err() {
        let out = git_cmd(agents_dir)
            .args(["init", "-q"])
            .output()
            .map_err(|e| format!("Failed to run git init in {}: {e}", agents_dir.display()))?;
        if !out.status.success() {
            return Err(format!(
                "git init failed in {}: {}",
                agents_dir.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }
    validate_dedicated_repo(agents_dir)
}

/// Stage and commit managed paths (`skills`, `overlord`, `AGENTS.md`) inside `~/.agents`
/// without disturbing unrelated staged or working-tree files. Returns `Ok(Some(sha))` when a commit is created.
pub fn commit_managed_changes(agents_dir: &Path, message: &str) -> Result<Option<String>, String> {
    validate_dedicated_repo(agents_dir)?;

    // Check status for managed paths (including deletions of tracked managed paths)
    let status_out = git_cmd(agents_dir)
        .args([
            "status",
            "--porcelain",
            "--",
            "skills",
            "overlord",
            "AGENTS.md",
        ])
        .output()
        .map_err(|e| {
            format!(
                "Failed to check git status in {}: {e}",
                agents_dir.display()
            )
        })?;
    if !status_out.status.success() {
        return Err(format!(
            "git status failed in {}: {}",
            agents_dir.display(),
            String::from_utf8_lossy(&status_out.stderr).trim()
        ));
    }
    if String::from_utf8_lossy(&status_out.stdout)
        .trim()
        .is_empty()
    {
        return Ok(None);
    }

    // `git add -A -- <pathspec>` requires each pathspec to exist on disk or in the index.
    let add_paths: Vec<&str> = ["skills", "overlord", "AGENTS.md"]
        .into_iter()
        .filter(|rel| {
            fs::symlink_metadata(agents_dir.join(rel)).is_ok() || path_in_index(agents_dir, rel)
        })
        .collect();

    if !add_paths.is_empty() {
        let add_out = git_cmd(agents_dir)
            .args(["add", "-A", "--"])
            .args(&add_paths)
            .output()
            .map_err(|e| {
                format!(
                    "Failed to stage managed files in {}: {e}",
                    agents_dir.display()
                )
            })?;
        if !add_out.status.success() {
            return Err(format!(
                "git add failed in {}: {}",
                agents_dir.display(),
                String::from_utf8_lossy(&add_out.stderr).trim()
            ));
        }
    }

    let has_head = git_cmd(agents_dir)
        .args(["rev-parse", "--verify", "-q", "HEAD"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    // `git commit --only -- <pathspec>` requires each pathspec to exist in the index or HEAD.
    let commit_paths: Vec<&str> = ["skills", "overlord", "AGENTS.md"]
        .into_iter()
        .filter(|rel| path_in_index(agents_dir, rel) || (has_head && path_in_head(agents_dir, rel)))
        .collect();
    if commit_paths.is_empty() {
        return Ok(None);
    }

    // Re-check staged diff on managed paths (git status --porcelain can include ignored/untracked edge cases)
    if has_head {
        let diff_cached = git_cmd(agents_dir)
            .args(["diff", "--cached", "--quiet", "--"])
            .args(&commit_paths)
            .output()
            .map_err(|e| format!("Failed to inspect staged changes: {e}"))?;
        if diff_cached.status.success() {
            return Ok(None);
        }
    }

    let mut commit = git_cmd(agents_dir);
    commit.args(["-c", "commit.gpgsign=false"]);
    // Ensure commits succeed in fresh test/CI environments without global git user.name/email
    if git_config_missing(agents_dir, "user.name") {
        commit.args(["-c", "user.name=Overlord"]);
    }
    if git_config_missing(agents_dir, "user.email") {
        commit.args(["-c", "user.email=overlord@localhost"]);
    }
    commit
        .args(["commit", "--no-verify", "-m", message, "--only", "--"])
        .args(&commit_paths);

    let commit_out = commit
        .output()
        .map_err(|e| format!("Failed to commit in {}: {e}", agents_dir.display()))?;
    if !commit_out.status.success() {
        return Err(format!(
            "git commit failed in {}: {}",
            agents_dir.display(),
            String::from_utf8_lossy(&commit_out.stderr).trim()
        ));
    }

    let rev = git_cmd(agents_dir)
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to read HEAD SHA: {e}"))?;
    let sha = String::from_utf8_lossy(&rev.stdout).trim().to_string();
    Ok(Some(sha))
}

fn path_in_index(repo_dir: &Path, rel: &str) -> bool {
    git_cmd(repo_dir)
        .args(["ls-files", "--", rel])
        .output()
        .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

fn path_in_head(repo_dir: &Path, rel: &str) -> bool {
    git_cmd(repo_dir)
        .args(["ls-tree", "HEAD", "--", rel])
        .output()
        .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

fn git_config_missing(repo_dir: &Path, key: &str) -> bool {
    git_cmd(repo_dir)
        .args(["config", "--get", key])
        .output()
        .map(|o| !o.status.success() || String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(true)
}
