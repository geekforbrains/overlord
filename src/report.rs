use std::path::Path;

use serde::Serialize;

use crate::config::ScopeKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: Severity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_path: Option<String>,
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl Diagnostic {
    pub fn error(
        scope: Option<&Path>,
        code: &'static str,
        message: impl Into<String>,
        path: Option<&Path>,
    ) -> Self {
        Self {
            severity: Severity::Error,
            scope_path: scope.map(|p| p.display().to_string()),
            code,
            message: message.into(),
            path: path.map(|p| p.display().to_string()),
        }
    }

    pub fn warning(
        scope: Option<&Path>,
        code: &'static str,
        message: impl Into<String>,
        path: Option<&Path>,
    ) -> Self {
        Self {
            severity: Severity::Warning,
            scope_path: scope.map(|p| p.display().to_string()),
            code,
            message: message.into(),
            path: path.map(|p| p.display().to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRecord {
    pub scope_path: String,
    pub kind: &'static str,
    pub name: String,
    pub action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<&'static str>,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionRecord {
    pub scope_path: String,
    pub kind: &'static str,
    pub name: String,
    pub state: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeReport {
    pub kind: &'static str,
    pub path: String,
    pub skills: usize,
    pub agents: usize,
    pub instructions: bool,
}

impl ScopeReport {
    pub fn new(
        kind: ScopeKind,
        path: &Path,
        skills: usize,
        agents: usize,
        instructions: bool,
    ) -> Self {
        Self {
            kind: kind.as_str(),
            path: path.display().to_string(),
            skills,
            agents,
            instructions,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub scopes: usize,
    pub definitions: usize,
    pub synced: usize,
    pub pending_or_applied_actions: usize,
    pub conflicts_or_errors: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub command: &'static str,
    pub dry_run: bool,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_commit: Option<String>,
    pub summary: Summary,
    pub scopes: Vec<ScopeReport>,
    pub definitions: Vec<DefinitionRecord>,
    pub actions: Vec<ActionRecord>,
    pub diagnostics: Vec<Diagnostic>,
}

impl RunReport {
    pub fn needs_attention(&self) -> bool {
        !self.diagnostics.is_empty()
    }

    pub fn print(&self, json: bool) -> Result<(), String> {
        if json {
            let out = serde_json::to_string_pretty(self)
                .map_err(|e| format!("Failed to serialize JSON output: {e}"))?;
            println!("{out}");
            return Ok(());
        }

        let status_word = if self.ok { "ok" } else { "attention-required" };
        println!("{}: {status_word}", self.command);
        println!(
            "  scopes: {}, definitions: {} ({} synced), actions: {}, issues: {}",
            self.summary.scopes,
            self.summary.definitions,
            self.summary.synced,
            self.actions.len(),
            self.diagnostics.len()
        );
        if let Some(sha) = &self.git_commit {
            println!("  git commit (~/.agents): {sha}");
        }
        for act in &self.actions {
            let verb = if self.dry_run { "plan" } else { "done" };
            match (&act.target, &act.detail) {
                (Some(t), Some(d)) => {
                    println!(
                        "  [{verb}] {} {} ({t}): {} ({d})",
                        act.action, act.name, act.path
                    )
                }
                (Some(t), None) => {
                    println!("  [{verb}] {} {} ({t}): {}", act.action, act.name, act.path)
                }
                (None, Some(d)) => {
                    println!("  [{verb}] {} {}: {} ({d})", act.action, act.name, act.path)
                }
                (None, None) => println!("  [{verb}] {} {}: {}", act.action, act.name, act.path),
            }
        }
        for diag in &self.diagnostics {
            let level = match diag.severity {
                Severity::Error => "error",
                Severity::Warning => "warn",
            };
            match (&diag.scope_path, &diag.path) {
                (Some(s), Some(p)) => {
                    println!("  [{level}] ({s}) {}: {} [{}]", diag.code, diag.message, p)
                }
                (Some(s), None) => println!("  [{level}] ({s}) {}: {}", diag.code, diag.message),
                (None, Some(p)) => println!("  [{level}] {}: {} [{}]", diag.code, diag.message, p),
                (None, None) => println!("  [{level}] {}: {}", diag.code, diag.message),
            }
        }
        Ok(())
    }
}
