use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::{EnvPaths, FleetConfig, Scope, canonical_or_lexical};
use crate::fsx::{is_claude_reserved_skill, is_ignored_junk};
use crate::report::Diagnostic;

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
    let real = canonical_or_lexical(dir);
    if is_project_candidate(dir, depth) && seen_real.insert(real) {
        project_paths.push(dir.to_path_buf());
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
    let marker_dirs = [
        (dir.join(".agents").join("skills"), false),
        (dir.join(".agents").join("overlord").join("agents"), false),
        (dir.join(".agents").join("agents"), false),
        (dir.join(".claude").join("skills"), true),
        (dir.join(".claude").join("agents"), false),
        (dir.join(".codex").join("agents"), false),
    ];

    for (marker, is_claude_skills) in marker_dirs {
        if has_meaningful_entries(&marker, is_claude_skills) {
            return true;
        }
    }

    if depth <= 1
        && (fs::symlink_metadata(dir.join("AGENTS.md")).is_ok()
            || fs::symlink_metadata(dir.join("CLAUDE.md")).is_ok())
    {
        return true;
    }

    false
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
