use std::fs;
use std::path::PathBuf;

use crate::config::{Scope, ScopeKind, Target};
use crate::fsx::{
    normalize_lexical, preferred_link_value, resolve_symlink_lexical, set_symlink,
    symlink_points_to, write_atomic,
};
use crate::report::{ActionRecord, DefinitionRecord, Diagnostic};

pub struct InstructionOutcome {
    pub present: bool,
    pub synced: bool,
    pub canonical_changed: bool,
}

pub fn sync_scope_instructions(
    scope: &Scope,
    dry_run: bool,
    definitions: &mut Vec<DefinitionRecord>,
    actions: &mut Vec<ActionRecord>,
    diagnostics: &mut Vec<Diagnostic>,
) -> InstructionOutcome {
    let mut outcome = InstructionOutcome {
        present: false,
        synced: false,
        canonical_changed: false,
    };

    let canon = &scope.canonical_instructions;
    let scope_str = scope.path.display().to_string();

    match fs::symlink_metadata(canon) {
        Ok(meta) => {
            outcome.present = true;
            if meta.file_type().is_symlink() || !meta.is_file() {
                diagnostics.push(Diagnostic::error(
                    Some(&scope.path),
                    "invalid-instructions",
                    "Canonical AGENTS.md must be a regular file, not a symlink or directory.",
                    Some(canon),
                ));
                definitions.push(DefinitionRecord {
                    scope_path: scope_str,
                    kind: "instructions",
                    name: "AGENTS.md".to_string(),
                    state: "invalid",
                });
                return outcome;
            }

            let canon_bytes = match fs::read(canon) {
                Ok(b) => b,
                Err(e) => {
                    diagnostics.push(Diagnostic::error(
                        Some(&scope.path),
                        "io-error",
                        format!("Failed to read {}: {e}", canon.display()),
                        Some(canon),
                    ));
                    definitions.push(DefinitionRecord {
                        scope_path: scope_str,
                        kind: "instructions",
                        name: "AGENTS.md".to_string(),
                        state: "error",
                    });
                    return outcome;
                }
            };

            let mut had_issue = false;
            let mut did_action = false;

            for (target, link_path) in &scope.instruction_links {
                let desired_val = preferred_link_value(link_path, canon, &scope.path);
                match fs::symlink_metadata(link_path) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        if !dry_run && let Err(err) = set_symlink(link_path, &desired_val) {
                            diagnostics.push(Diagnostic::error(
                                Some(&scope.path),
                                "write-failed",
                                err,
                                Some(link_path),
                            ));
                            had_issue = true;
                            continue;
                        }
                        did_action = true;
                        actions.push(ActionRecord {
                            scope_path: scope_str.clone(),
                            kind: "instructions",
                            name: "AGENTS.md".to_string(),
                            action: "link",
                            target: Some(target.as_str()),
                            path: link_path.display().to_string(),
                            detail: Some(format!("-> {}", desired_val.display())),
                        });
                    }
                    Ok(m) if m.file_type().is_symlink() => {
                        if !symlink_points_to(link_path, canon) {
                            had_issue = true;
                            let current = fs::read_link(link_path)
                                .map(|p| p.display().to_string())
                                .unwrap_or_else(|_| "<unreadable>".to_string());
                            diagnostics.push(Diagnostic::warning(
                                Some(&scope.path),
                                "foreign-instructions-symlink",
                                format!(
                                    "Symlink points to '{current}' instead of '{}'; leaving untouched.",
                                    canon.display()
                                ),
                                Some(link_path),
                            ));
                        }
                    }
                    Ok(m) if m.is_file() => match fs::read(link_path) {
                        Ok(bytes) if bytes == canon_bytes => {
                            if !dry_run && let Err(err) = set_symlink(link_path, &desired_val) {
                                diagnostics.push(Diagnostic::error(
                                    Some(&scope.path),
                                    "write-failed",
                                    err,
                                    Some(link_path),
                                ));
                                had_issue = true;
                                continue;
                            }
                            did_action = true;
                            actions.push(ActionRecord {
                                scope_path: scope_str.clone(),
                                kind: "instructions",
                                name: "AGENTS.md".to_string(),
                                action: "replace-copy-with-link",
                                target: Some(target.as_str()),
                                path: link_path.display().to_string(),
                                detail: Some(format!("-> {}", desired_val.display())),
                            });
                        }
                        Ok(bytes) if is_delegating_claude_import(&bytes, *target) => {
                            // e.g. upstream repos whose CLAUDE.md is literally `@AGENTS.md`
                        }
                        Ok(_) => {
                            had_issue = true;
                            diagnostics.push(Diagnostic::warning(
                                Some(&scope.path),
                                "instructions-conflict",
                                format!(
                                    "{} differs from canonical AGENTS.md; resolve manually.",
                                    link_path.display()
                                ),
                                Some(link_path),
                            ));
                        }
                        Err(e) => {
                            had_issue = true;
                            diagnostics.push(Diagnostic::error(
                                Some(&scope.path),
                                "io-error",
                                format!("Failed to read {}: {e}", link_path.display()),
                                Some(link_path),
                            ));
                        }
                    },
                    Ok(_) => {
                        had_issue = true;
                        diagnostics.push(Diagnostic::warning(
                            Some(&scope.path),
                            "unexpected-instructions-entry",
                            "Expected file or symlink for instruction file.",
                            Some(link_path),
                        ));
                    }
                    Err(e) => {
                        had_issue = true;
                        diagnostics.push(Diagnostic::error(
                            Some(&scope.path),
                            "io-error",
                            format!("Failed to inspect {}: {e}", link_path.display()),
                            Some(link_path),
                        ));
                    }
                }
            }

            let state = if had_issue {
                "conflict"
            } else if dry_run && did_action {
                "pending"
            } else {
                outcome.synced = true;
                "synced"
            };
            definitions.push(DefinitionRecord {
                scope_path: scope_str,
                kind: "instructions",
                name: "AGENTS.md".to_string(),
                state,
            });
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Canonical AGENTS.md absent: check for stale links or adoptable regular file (e.g. standalone CLAUDE.md)
            let mut candidates: Vec<(Target, PathBuf, Vec<u8>)> = Vec::new();
            for (target, link_path) in &scope.instruction_links {
                let Ok(m) = fs::symlink_metadata(link_path) else {
                    continue;
                };
                if m.file_type().is_symlink() {
                    if let Ok(resolved) = resolve_symlink_lexical(link_path)
                        && resolved == normalize_lexical(canon)
                    {
                        if !dry_run {
                            let _ = fs::remove_file(link_path);
                        }
                        actions.push(ActionRecord {
                            scope_path: scope_str.clone(),
                            kind: "instructions",
                            name: "AGENTS.md".to_string(),
                            action: "remove-stale-link",
                            target: Some(target.as_str()),
                            path: link_path.display().to_string(),
                            detail: None,
                        });
                    }
                } else if m.is_file()
                    && let Ok(bytes) = fs::read(link_path)
                    && !is_delegating_claude_import(&bytes, *target)
                {
                    candidates.push((*target, link_path.clone(), bytes));
                }
            }

            if candidates.is_empty() {
                return outcome;
            }

            outcome.present = true;
            let first_bytes = &candidates[0].2;
            if !candidates.iter().all(|(_, _, b)| b == first_bytes) {
                diagnostics.push(Diagnostic::warning(
                    Some(&scope.path),
                    "instructions-adopt-conflict",
                    "Multiple differing provider instruction files exist with no canonical AGENTS.md.",
                    Some(&candidates[0].1),
                ));
                definitions.push(DefinitionRecord {
                    scope_path: scope_str,
                    kind: "instructions",
                    name: "AGENTS.md".to_string(),
                    state: "conflict",
                });
                return outcome;
            }

            let from_target = candidates[0].0;
            if !dry_run {
                if let Err(err) = write_atomic(canon, first_bytes, None) {
                    diagnostics.push(Diagnostic::error(
                        Some(&scope.path),
                        "adopt-failed",
                        err,
                        Some(canon),
                    ));
                    definitions.push(DefinitionRecord {
                        scope_path: scope_str,
                        kind: "instructions",
                        name: "AGENTS.md".to_string(),
                        state: "error",
                    });
                    return outcome;
                }
                if scope.kind == ScopeKind::User {
                    outcome.canonical_changed = true;
                }
            }

            actions.push(ActionRecord {
                scope_path: scope_str.clone(),
                kind: "instructions",
                name: "AGENTS.md".to_string(),
                action: "adopt",
                target: Some(from_target.as_str()),
                path: canon.display().to_string(),
                detail: Some(format!("from {}", from_target.as_str())),
            });

            let mut link_err = false;
            for (target, link_path) in &scope.instruction_links {
                let desired_val = preferred_link_value(link_path, canon, &scope.path);
                if !dry_run && let Err(err) = set_symlink(link_path, &desired_val) {
                    diagnostics.push(Diagnostic::error(
                        Some(&scope.path),
                        "write-failed",
                        err,
                        Some(link_path),
                    ));
                    link_err = true;
                    continue;
                }
                actions.push(ActionRecord {
                    scope_path: scope_str.clone(),
                    kind: "instructions",
                    name: "AGENTS.md".to_string(),
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
                outcome.synced = true;
                "synced"
            };
            definitions.push(DefinitionRecord {
                scope_path: scope_str,
                kind: "instructions",
                name: "AGENTS.md".to_string(),
                state,
            });
        }
        Err(e) => {
            diagnostics.push(Diagnostic::error(
                Some(&scope.path),
                "io-error",
                format!("Failed to inspect {}: {e}", canon.display()),
                Some(canon),
            ));
        }
    }

    outcome
}

fn is_delegating_claude_import(bytes: &[u8], target: Target) -> bool {
    if target != Target::Claude {
        return false;
    }
    let Ok(s) = std::str::from_utf8(bytes) else {
        return false;
    };
    matches!(s.trim(), "@AGENTS.md" | "@./AGENTS.md")
}
