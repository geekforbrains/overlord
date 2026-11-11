use std::fs;

use crate::agent::sync_scope_agents;
use crate::config::{EnvPaths, ScopeKind, load_config};
use crate::fsx::write_atomic;
use crate::git::{commit_managed_changes, init_or_validate_repo, validate_dedicated_repo};
use crate::instructions::sync_scope_instructions;
use crate::report::{
    ActionRecord, DefinitionRecord, Diagnostic, RunReport, ScopeReport, Severity, Summary,
};
use crate::scope::discover_scopes;
use crate::skills::sync_scope_skills;
use crate::state::{StateFile, acquire_lock};

const BUNDLED_OVERLORD_SKILL: &str = include_str!("../assets/overlord/SKILL.md");

pub fn run_init(env: &EnvPaths) -> Result<RunReport, String> {
    env.validate_non_overlapping()?;
    let _lock = acquire_lock(&env.state_dir, "sync.lock")?;

    let agents_dir = env.user_agents_dir();
    let skills_dir = agents_dir.join("skills");
    let canon_agents_dir = agents_dir.join("overlord").join("agents");
    let cfg_path = env.config_file();

    // Validate existing config before initializing if it already exists
    if fs::symlink_metadata(&cfg_path).is_ok() {
        load_config(env)?;
    }

    fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("Failed to create {}: {e}", skills_dir.display()))?;
    fs::create_dir_all(&canon_agents_dir)
        .map_err(|e| format!("Failed to create {}: {e}", canon_agents_dir.display()))?;

    let mut actions = Vec::new();
    let scope_str = env.home.display().to_string();

    if fs::symlink_metadata(&cfg_path).is_err() {
        write_atomic(&cfg_path, b"roots: []\n", None)?;
        actions.push(ActionRecord {
            scope_path: scope_str.clone(),
            kind: "config",
            name: "overlord.yaml".to_string(),
            action: "create",
            target: None,
            path: cfg_path.display().to_string(),
            detail: None,
        });
    }

    let bundled_skill_md = skills_dir.join("overlord").join("SKILL.md");
    if fs::symlink_metadata(&bundled_skill_md).is_err() {
        write_atomic(&bundled_skill_md, BUNDLED_OVERLORD_SKILL.as_bytes(), None)?;
        actions.push(ActionRecord {
            scope_path: scope_str,
            kind: "skill",
            name: "overlord".to_string(),
            action: "install-bundled",
            target: None,
            path: bundled_skill_md.display().to_string(),
            detail: None,
        });
    }

    init_or_validate_repo(&agents_dir)?;
    let git_commit = commit_managed_changes(&agents_dir, "chore(overlord): initialize")?;

    // Ensure state directory exists
    let state = StateFile::load(&env.state_dir)?;
    state.save(&env.state_dir)?;

    Ok(RunReport {
        command: "init",
        dry_run: false,
        ok: true,
        git_commit,
        summary: Summary {
            scopes: 1,
            definitions: 0,
            synced: 0,
            pending_or_applied_actions: actions.len(),
            conflicts_or_errors: 0,
        },
        scopes: vec![ScopeReport::new(ScopeKind::User, &env.home, 0, 0, false)],
        definitions: Vec::new(),
        actions,
        diagnostics: Vec::new(),
    })
}

pub fn run_fleet(
    env: &EnvPaths,
    command: &'static str,
    dry_run: bool,
    fail_on_pending: bool,
) -> Result<RunReport, String> {
    env.validate_non_overlapping()?;
    let agents_dir = env.user_agents_dir();
    validate_dedicated_repo(&agents_dir)?;
    let cfg = load_config(env)?;

    let _lock = if dry_run {
        None
    } else {
        Some(acquire_lock(&env.state_dir, "sync.lock")?)
    };

    let mut state = StateFile::load(&env.state_dir)?;
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let mut actions: Vec<ActionRecord> = Vec::new();
    let mut definitions: Vec<DefinitionRecord> = Vec::new();
    let mut scope_reports: Vec<ScopeReport> = Vec::new();

    let scopes = discover_scopes(env, &cfg, &mut diagnostics);
    let mut total_defs = 0usize;
    let mut total_synced = 0usize;
    let mut state_changed = false;

    for scope in &scopes {
        let diag_before = diagnostics.len();
        let skill_out = sync_scope_skills(
            scope,
            dry_run,
            &mut definitions,
            &mut actions,
            &mut diagnostics,
        );
        let agent_out = sync_scope_agents(
            scope,
            dry_run,
            &mut state,
            &mut definitions,
            &mut actions,
            &mut diagnostics,
        );
        let instr_out = sync_scope_instructions(
            scope,
            dry_run,
            &mut definitions,
            &mut actions,
            &mut diagnostics,
        );

        let _ = (
            skill_out.canonical_changed,
            agent_out.canonical_changed,
            instr_out.canonical_changed,
            diag_before,
        );
        if agent_out.state_changed {
            state_changed = true;
        }

        let scope_defs = skill_out.total + agent_out.total + usize::from(instr_out.present);
        let scope_synced = skill_out.synced + agent_out.synced + usize::from(instr_out.synced);
        total_defs += scope_defs;
        total_synced += scope_synced;

        scope_reports.push(ScopeReport::new(
            scope.kind,
            &scope.path,
            skill_out.total,
            agent_out.total,
            instr_out.present,
        ));
    }

    // Prune state entries for project scopes that were removed from disk (only when all configured roots were readable)
    let has_root_errors = diagnostics.iter().any(|d| d.code.ends_with("-root"));
    if !has_root_errors {
        let active_scope_keys: std::collections::BTreeSet<String> = scopes
            .iter()
            .map(|s| s.path.display().to_string())
            .collect();
        let stale_keys: Vec<String> = state
            .agents
            .keys()
            .filter(|k| !active_scope_keys.contains(*k))
            .cloned()
            .collect();
        for key in stale_keys {
            if !dry_run {
                state.agents.remove(&key);
                state_changed = true;
            }
        }
    }

    let user_has_canonical_errors = diagnostics.iter().any(|d| {
        d.severity == Severity::Error
            && d.scope_path.as_deref() == Some(env.home.to_string_lossy().as_ref())
    });

    let mut git_commit = None;
    if !dry_run && !user_has_canonical_errors {
        match commit_managed_changes(&agents_dir, "chore(overlord): sync") {
            Ok(sha) => git_commit = sha,
            Err(err) => {
                diagnostics.push(Diagnostic::error(
                    Some(&env.home),
                    "git-commit-failed",
                    err,
                    Some(&agents_dir),
                ));
            }
        }
    }

    if !dry_run && state_changed {
        state.save(&env.state_dir)?;
    }

    let has_issues = !diagnostics.is_empty();
    let has_pending = fail_on_pending && !actions.is_empty();
    let ok = !has_issues && !has_pending;

    Ok(RunReport {
        command,
        dry_run,
        ok,
        git_commit,
        summary: Summary {
            scopes: scopes.len(),
            definitions: total_defs,
            synced: total_synced,
            pending_or_applied_actions: actions.len(),
            conflicts_or_errors: diagnostics.len(),
        },
        scopes: scope_reports,
        definitions,
        actions,
        diagnostics,
    })
}
