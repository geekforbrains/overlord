use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::{EnvPaths, FleetConfig, Scope, canonical_or_lexical};
use crate::fsx::{is_claude_reserved_skill, is_ignored_junk};
use crate::report::Diagnostic;

const MAX_DISCOVERY_DEPTH: usize = 4;

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    "venv",
    "__pycache__",
    "vendor",
    "Pods",
    "DerivedData",
    "bower_components",
];

pub fn discover_scopes(
    env: &EnvPaths,
    config: &FleetConfig,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<Scope> {
    let mut scopes = vec![Scope::user(env)];
    let home_real = canonical_or_lexical(&env.home);
    let mut seen_real = BTreeSet::new();
    seen_real.insert(home_real);

    let mut project_paths = Vec::new();
    for root in &config.roots {
        let meta = match fs::symlink_metadata(root) {
            Ok(m) => m,
            Err(e) => {
                diagnostics.push(Diagnostic::error(
                    None,
                    "invalid-root",
                    format!("Configured root is inaccessible ({e})."),
                    Some(root),
                ));
                continue;
            }
        };
        if meta.file_type().is_symlink() {
            diagnostics.push(Diagnostic::error(
                None,
                "symlink-root",
                "Configured discovery root must be a physical directory, not a symlink.",
                Some(root),
            ));
            continue;
        }
        if !meta.is_dir() {
            diagnostics.push(Diagnostic::error(
                None,
                "non-directory-root",
                "Configured discovery root must be a directory.",
                Some(root),
            ));
            continue;
        }

        walk_root(root, 0, &mut seen_real, &mut project_paths, diagnostics);
    }

    project_paths.sort();
    for path in project_paths {
        scopes.push(Scope::project(path));
    }
    scopes
}

fn walk_root(
    dir: &Path,
    depth: usize,
    seen_real: &mut BTreeSet<PathBuf>,
    project_paths: &mut Vec<PathBuf>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if is_project_candidate(dir, depth) && seen_real.insert(canonical_or_lexical(dir)) {
        project_paths.push(dir.to_path_buf());
    }

    if depth >= MAX_DISCOVERY_DEPTH {
        return;
    }

    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => {
            if depth == 0 {
                diagnostics.push(Diagnostic::error(
                    None,
                    "unreadable-root",
                    format!("Failed to scan configured root: {e}"),
                    Some(dir),
                ));
            }
            return;
        }
    };

    let mut children = Vec::new();
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() || !ft.is_dir() {
            continue;
        }
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
            continue;
        }
        children.push(entry.path());
    }
    children.sort();

    for child in children {
        walk_root(&child, depth + 1, seen_real, project_paths, diagnostics);
    }
}

fn is_project_candidate(dir: &Path, depth: usize) -> bool {
    let dot_agents = dir.join(".agents");
    if is_physical_dir(&dot_agents)
        && (has_meaningful_entries(&dot_agents.join("skills"), false)
            || has_meaningful_entries(&dot_agents.join("overlord").join("agents"), false)
            || has_meaningful_entries(&dot_agents.join("agents"), false))
    {
        return true;
    }

    let dot_claude = dir.join(".claude");
    if is_physical_dir(&dot_claude)
        && (has_meaningful_entries(&dot_claude.join("skills"), true)
            || has_meaningful_entries(&dot_claude.join("agents"), false))
    {
        return true;
    }

    let dot_codex = dir.join(".codex");
    if is_physical_dir(&dot_codex) && has_meaningful_entries(&dot_codex.join("agents"), false) {
        return true;
    }

    if (depth <= 1 || fs::symlink_metadata(dir.join(".git")).is_ok())
        && (fs::symlink_metadata(dir.join("AGENTS.md")).is_ok()
            || fs::symlink_metadata(dir.join("CLAUDE.md")).is_ok())
    {
        return true;
    }

    false
}

fn is_physical_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| !m.file_type().is_symlink() && m.is_dir())
        .unwrap_or(false)
}

fn has_meaningful_entries(dir: &Path, is_claude_skills: bool) -> bool {
    let Ok(meta) = fs::symlink_metadata(dir) else {
        return false;
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return false;
    }
    let Ok(rd) = fs::read_dir(dir) else {
        return false;
    };
    for entry in rd.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if is_ignored_junk(&name) {
            continue;
        }
        if is_claude_skills && is_claude_reserved_skill(&name) {
            continue;
        }
        return true;
    }
    false
}
