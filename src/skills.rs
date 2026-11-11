use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::config::{Scope, ScopeKind, Target};
use crate::fsx::{
    SkillFileEntry, is_claude_reserved_skill, is_ignored_junk, normalize_lexical,
    preferred_link_value, read_skill_tree, resolve_symlink_lexical, set_symlink, symlink_points_to,
    write_skill_tree_exclusive,
};
use crate::report::{ActionRecord, DefinitionRecord, Diagnostic};

#[derive(Debug, Deserialize)]
struct SkillFrontmatter {
    name: Option<String>,
    description: Option<String>,
}

pub fn is_valid_skill_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 || is_claude_reserved_skill(name) {
        return false;
    }
    if name.starts_with('-') || name.ends_with('-') || name.contains("--") {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn validate_skill_dir(dir: &Path, expected_name: &str) -> Result<Vec<SkillFileEntry>, String> {
    if !is_valid_skill_name(expected_name) {
        return Err(format!("Invalid skill name '{expected_name}'."));
    }
    let files = read_skill_tree(dir)?;
    let skill_md = files
        .iter()
        .find(|f| f.rel_path == "SKILL.md")
        .ok_or_else(|| format!("Skill '{}' is missing SKILL.md.", dir.display()))?;

    let text = std::str::from_utf8(&skill_md.bytes)
        .map_err(|_| format!("{}/SKILL.md is not valid UTF-8.", dir.display()))?;
    let (yaml_str, _body) = split_frontmatter(text).ok_or_else(|| {
        format!(
            "{}/SKILL.md must start with YAML frontmatter.",
            dir.display()
        )
    })?;

    let mut opts = serde_saphyr::Options::default();
    opts.strict_booleans = true;
    let fm: SkillFrontmatter =
        serde_saphyr::from_str_with_options(yaml_str, opts).map_err(|e| {
            format!(
                "{}/SKILL.md has invalid YAML frontmatter: {e}",
                dir.display()
            )
        })?;

    let fm_name = fm
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!(
                "{}/SKILL.md requires a non-empty 'name' field.",
                dir.display()
            )
        })?;
    if fm_name != expected_name {
        return Err(format!(
            "{}/SKILL.md name '{fm_name}' does not match directory name '{expected_name}'.",
            dir.display()
        ));
    }
    let desc = fm
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!(
                "{}/SKILL.md requires a non-empty 'description' field.",
                dir.display()
            )
        })?;
    if desc.chars().count() > 1024 {
        return Err(format!(
            "{}/SKILL.md description exceeds 1024 characters.",
            dir.display()
        ));
    }

    Ok(files)
}

pub fn split_frontmatter(source: &str) -> Option<(&str, &str)> {
    let rest = source
        .strip_prefix("---\n")
        .or_else(|| source.strip_prefix("---\r\n"))?;
    if let Some(after_empty) = rest
        .strip_prefix("---\n")
        .or_else(|| rest.strip_prefix("---\r\n"))
    {
        return Some(("", after_empty));
    }
    if rest == "---" {
        return Some(("", ""));
    }

    let mut search_from = 0usize;
    while let Some(rel_idx) = rest[search_from..].find("\n---") {
        let idx = search_from + rel_idx;
        let after = &rest[idx + 4..];
        if after.is_empty() {
            return Some((&rest[..idx], ""));
        }
        if let Some(body) = after.strip_prefix('\n') {
            return Some((&rest[..idx], body));
        }
        if let Some(body) = after.strip_prefix("\r\n") {
            return Some((&rest[..idx], body));
        }
        search_from = idx + 4;
    }
    None
}

pub struct SkillScopeOutcome {
    pub total: usize,
    pub synced: usize,
    pub canonical_changed: bool,
}

pub fn sync_scope_skills(
    scope: &Scope,
    dry_run: bool,
    definitions: &mut Vec<DefinitionRecord>,
    actions: &mut Vec<ActionRecord>,
    diagnostics: &mut Vec<Diagnostic>,
) -> SkillScopeOutcome {
    let mut outcome = SkillScopeOutcome {
        total: 0,
        synced: 0,
        canonical_changed: false,
    };

    // Validate canonical skills container if present
    if let Ok(meta) = fs::symlink_metadata(&scope.canonical_skills)
        && (meta.file_type().is_symlink() || !meta.is_dir())
    {
        diagnostics.push(Diagnostic::error(
            Some(&scope.path),
            "invalid-skill-root",
            "Canonical .agents/skills must be a physical directory.",
            Some(&scope.canonical_skills),
        ));
        return outcome;
    }

    // Validate target skill containers if present
    let mut valid_targets: Vec<(Target, PathBuf)> = Vec::new();
    for (target, root) in &scope.skill_links {
        if let Ok(meta) = fs::symlink_metadata(root)
            && (meta.file_type().is_symlink() || !meta.is_dir())
        {
            diagnostics.push(Diagnostic::error(
                Some(&scope.path),
                "symlinked-skill-root",
                format!(
                    "{} skills root must be a physical directory, not a symlink (per-skill symlinks go inside it).",
                    target.as_str()
                ),
                Some(root),
            ));
            continue;
        }
        valid_targets.push((*target, root.clone()));
    }

    let mut names = BTreeSet::new();
    collect_entry_names(&scope.canonical_skills, false, &mut names);
    for (target, root) in &valid_targets {
        collect_entry_names(root, *target == Target::Claude, &mut names);
    }

    let scope_str = scope.path.display().to_string();

    for name in names {
        if is_claude_reserved_skill(&name) {
            if fs::symlink_metadata(scope.canonical_skills.join(&name)).is_ok() {
                outcome.total += 1;
                diagnostics.push(Diagnostic::error(
                    Some(&scope.path),
                    "reserved-skill-name",
                    format!("'{name}' is reserved by Claude Code and cannot be a canonical skill."),
                    Some(&scope.canonical_skills.join(&name)),
                ));
                definitions.push(DefinitionRecord {
                    scope_path: scope_str.clone(),
                    kind: "skill",
                    name,
                    state: "invalid",
                });
            }
            continue;
        }

        let canon_dir = scope.canonical_skills.join(&name);
        let canon_exists = fs::symlink_metadata(&canon_dir).is_ok();

        if canon_exists {
            outcome.total += 1;
            let canon_files = match validate_skill_dir(&canon_dir, &name) {
                Ok(f) => f,
                Err(msg) => {
                    diagnostics.push(Diagnostic::error(
                        Some(&scope.path),
                        "invalid-skill",
                        msg,
                        Some(&canon_dir),
                    ));
                    definitions.push(DefinitionRecord {
                        scope_path: scope_str.clone(),
                        kind: "skill",
                        name,
                        state: "invalid",
                    });
                    continue;
                }
            };

            let mut had_issue = false;
            let mut did_action = false;

            for (target, root) in &valid_targets {
                let link_path = root.join(&name);
                let desired_val = preferred_link_value(&link_path, &canon_dir, &scope.path);
                match fs::symlink_metadata(&link_path) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        if !dry_run && let Err(err) = set_symlink(&link_path, &desired_val) {
                            diagnostics.push(Diagnostic::error(
                                Some(&scope.path),
                                "write-failed",
                                err,
                                Some(&link_path),
                            ));
                            had_issue = true;
                            continue;
                        }
                        did_action = true;
                        actions.push(ActionRecord {
                            scope_path: scope_str.clone(),
                            kind: "skill",
                            name: name.clone(),
                            action: "link",
                            target: Some(target.as_str()),
                            path: link_path.display().to_string(),
                            detail: Some(format!("-> {}", desired_val.display())),
                        });
                    }
                    Ok(meta) if meta.file_type().is_symlink() => {
                        if symlink_points_to(&link_path, &canon_dir) {
                            // Already cleanly linked
                        } else {
                            had_issue = true;
                            let current = fs::read_link(&link_path)
                                .map(|p| p.display().to_string())
                                .unwrap_or_else(|_| "<unreadable>".to_string());
                            diagnostics.push(Diagnostic::warning(
                                Some(&scope.path),
                                "foreign-skill-symlink",
                                format!(
                                    "Symlink points to '{current}' instead of canonical '{}'; leaving untouched.",
                                    canon_dir.display()
                                ),
                                Some(&link_path),
                            ));
                        }
                    }
                    Ok(meta) if meta.is_dir() => match read_skill_tree(&link_path) {
                        Ok(target_files) if target_files == canon_files => {
                            if !dry_run && let Err(err) = set_symlink(&link_path, &desired_val) {
                                diagnostics.push(Diagnostic::error(
                                    Some(&scope.path),
                                    "write-failed",
                                    err,
                                    Some(&link_path),
                                ));
                                had_issue = true;
                                continue;
                            }
                            did_action = true;
                            actions.push(ActionRecord {
                                scope_path: scope_str.clone(),
                                kind: "skill",
                                name: name.clone(),
                                action: "replace-copy-with-link",
                                target: Some(target.as_str()),
                                path: link_path.display().to_string(),
                                detail: Some(format!("-> {}", desired_val.display())),
                            });
                        }
                        Ok(_) => {
                            had_issue = true;
                            diagnostics.push(Diagnostic::warning(
                                Some(&scope.path),
                                "skill-conflict",
                                format!(
                                    "Physical directory in {} differs from canonical .agents/skills/{name}; resolve manually.",
                                    target.as_str()
                                ),
                                Some(&link_path),
                            ));
                        }
                        Err(err) => {
                            had_issue = true;
                            diagnostics.push(Diagnostic::error(
                                Some(&scope.path),
                                "invalid-native-skill",
                                err,
                                Some(&link_path),
                            ));
                        }
                    },
                    Ok(_) => {
                        had_issue = true;
                        diagnostics.push(Diagnostic::warning(
                            Some(&scope.path),
                            "unexpected-skill-entry",
                            "Expected a skill directory or symlink, found a regular file.",
                            Some(&link_path),
                        ));
                    }
                    Err(e) => {
                        had_issue = true;
                        diagnostics.push(Diagnostic::error(
                            Some(&scope.path),
                            "io-error",
                            format!("Failed to inspect {}: {e}", link_path.display()),
                            Some(&link_path),
                        ));
                    }
                }
            }

            let state = if had_issue {
                "conflict"
            } else if dry_run && did_action {
                "pending"
            } else {
                outcome.synced += 1;
                "synced"
            };
            definitions.push(DefinitionRecord {
                scope_path: scope_str.clone(),
                kind: "skill",
                name,
                state,
            });
        } else {
            // Canonical does NOT exist: check for stale links or adoptable physical native skills
            let mut adopt_candidates: Vec<(Target, PathBuf, Vec<SkillFileEntry>)> = Vec::new();
            let mut had_issue = false;

            for (target, root) in &valid_targets {
                let entry_path = root.join(&name);
                let Ok(meta) = fs::symlink_metadata(&entry_path) else {
                    continue;
                };
                if meta.file_type().is_symlink() {
                    // Remove only if it points into this scope's .agents/skills/<name>
                    if let Ok(resolved) = resolve_symlink_lexical(&entry_path)
                        && resolved == normalize_lexical(&canon_dir)
                    {
                        if !dry_run && let Err(e) = fs::remove_file(&entry_path) {
                            diagnostics.push(Diagnostic::error(
                                Some(&scope.path),
                                "remove-failed",
                                format!("Failed to remove stale symlink: {e}"),
                                Some(&entry_path),
                            ));
                            had_issue = true;
                            continue;
                        }
                        actions.push(ActionRecord {
                            scope_path: scope_str.clone(),
                            kind: "skill",
                            name: name.clone(),
                            action: "remove-stale-link",
                            target: Some(target.as_str()),
                            path: entry_path.display().to_string(),
                            detail: None,
                        });
                    }
                    // Foreign symlinks pointing elsewhere are intentionally ignored.
                } else if meta.is_dir() {
                    match validate_skill_dir(&entry_path, &name) {
                        Ok(files) => adopt_candidates.push((*target, entry_path, files)),
                        Err(msg) => {
                            had_issue = true;
                            diagnostics.push(Diagnostic::error(
                                Some(&scope.path),
                                "invalid-native-skill",
                                msg,
                                Some(&entry_path),
                            ));
                        }
                    }
                }
            }

            if adopt_candidates.is_empty() {
                if had_issue {
                    outcome.total += 1;
                    definitions.push(DefinitionRecord {
                        scope_path: scope_str.clone(),
                        kind: "skill",
                        name,
                        state: "invalid",
                    });
                }
                continue;
            }

            outcome.total += 1;
            let first_files = &adopt_candidates[0].2;
            let all_agree = adopt_candidates.iter().all(|(_, _, f)| f == first_files);
            if !all_agree || had_issue {
                diagnostics.push(Diagnostic::warning(
                    Some(&scope.path),
                    "skill-adopt-conflict",
                    format!(
                        "Multiple providers created conflicting versions of skill '{name}' with no canonical copy."
                    ),
                    Some(&adopt_candidates[0].1),
                ));
                definitions.push(DefinitionRecord {
                    scope_path: scope_str.clone(),
                    kind: "skill",
                    name,
                    state: "conflict",
                });
                continue;
            }

            let source_target = adopt_candidates[0].0;
            if !dry_run {
                if let Err(err) = write_skill_tree_exclusive(&canon_dir, first_files) {
                    diagnostics.push(Diagnostic::error(
                        Some(&scope.path),
                        "adopt-failed",
                        err,
                        Some(&canon_dir),
                    ));
                    definitions.push(DefinitionRecord {
                        scope_path: scope_str.clone(),
                        kind: "skill",
                        name,
                        state: "error",
                    });
                    continue;
                }
                if scope.kind == ScopeKind::User {
                    outcome.canonical_changed = true;
                }
            }

            actions.push(ActionRecord {
                scope_path: scope_str.clone(),
                kind: "skill",
                name: name.clone(),
                action: "adopt",
                target: Some(source_target.as_str()),
                path: canon_dir.display().to_string(),
                detail: Some(format!("from {}", source_target.as_str())),
            });

            let mut link_err = false;
            for (target, root) in &valid_targets {
                let link_path = root.join(&name);
                let desired_val = preferred_link_value(&link_path, &canon_dir, &scope.path);
                if !dry_run && let Err(err) = set_symlink(&link_path, &desired_val) {
                    diagnostics.push(Diagnostic::error(
                        Some(&scope.path),
                        "write-failed",
                        err,
                        Some(&link_path),
                    ));
                    link_err = true;
                    continue;
                }
                actions.push(ActionRecord {
                    scope_path: scope_str.clone(),
                    kind: "skill",
                    name: name.clone(),
                    action: "link",
                    target: Some(target.as_str()),
                    path: link_path.display().to_string(),
                    detail: Some(format!("-> {}", desired_val.display())),
                });
            }

            let state = if link_err {
                "error"
            } else if dry_run {
                "pending"
            } else {
                outcome.synced += 1;
                "synced"
            };
            definitions.push(DefinitionRecord {
                scope_path: scope_str.clone(),
                kind: "skill",
                name,
                state,
            });
        }
    }

    outcome
}

fn collect_entry_names(dir: &Path, skip_claude_reserved: bool, out: &mut BTreeSet<String>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if is_ignored_junk(&name) || name.starts_with(".overlord-") {
            continue;
        }
        if skip_claude_reserved && is_claude_reserved_skill(&name) {
            continue;
        }
        out.insert(name.into_owned());
    }
}
