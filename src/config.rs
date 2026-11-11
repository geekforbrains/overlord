use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct EnvPaths {
    pub home: PathBuf,
    pub claude_dir: PathBuf,
    pub codex_dir: PathBuf,
    pub gemini_dir: PathBuf,
    pub state_dir: PathBuf,
    pub config_home: PathBuf,
}

impl EnvPaths {
    pub fn from_env() -> Result<Self, String> {
        let home_str = env::var("HOME")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| "HOME environment variable is not set.".to_string())?;
        let home = PathBuf::from(&home_str);
        if !home.is_absolute() {
            return Err(format!("HOME must be an absolute path: {}", home.display()));
        }

        let claude_dir = resolve_env_dir("CLAUDE_CONFIG_DIR", &home, &home.join(".claude"));
        let codex_dir = resolve_env_dir("CODEX_HOME", &home, &home.join(".codex"));
        let gemini_dir = resolve_env_dir("GEMINI_DIR", &home, &home.join(".gemini"));
        let state_base =
            resolve_env_dir("XDG_STATE_HOME", &home, &home.join(".local").join("state"));
        let config_home = resolve_env_dir("XDG_CONFIG_HOME", &home, &home.join(".config"));

        Ok(Self {
            home,
            claude_dir,
            codex_dir,
            gemini_dir,
            state_dir: state_base.join("overlord"),
            config_home,
        })
    }

    pub fn user_agents_dir(&self) -> PathBuf {
        self.home.join(".agents")
    }

    pub fn config_file(&self) -> PathBuf {
        self.user_agents_dir()
            .join("overlord")
            .join("overlord.yaml")
    }

    pub fn validate_non_overlapping(&self) -> Result<(), String> {
        let canonical = canonical_or_lexical(&self.user_agents_dir());
        let providers = [
            ("CLAUDE_CONFIG_DIR", &self.claude_dir),
            ("CODEX_HOME", &self.codex_dir),
            ("GEMINI_DIR", &self.gemini_dir),
        ];
        for (name, dir) in providers {
            let resolved = canonical_or_lexical(dir);
            if paths_overlap(&canonical, &resolved) {
                return Err(format!(
                    "{name} ({}) overlaps canonical user directory ({}).",
                    dir.display(),
                    self.user_agents_dir().display()
                ));
            }
        }
        Ok(())
    }
}

fn resolve_env_dir(var: &str, home: &Path, fallback: &Path) -> PathBuf {
    match env::var(var).ok().filter(|v| !v.trim().is_empty()) {
        Some(raw) => expand_user_path(&raw, home),
        None => fallback.to_path_buf(),
    }
}

pub fn expand_user_path(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        home.to_path_buf()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else {
        let p = PathBuf::from(raw);
        if p.is_absolute() { p } else { home.join(p) }
    }
}

pub fn canonical_or_lexical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| crate::fsx::normalize_lexical(path))
}

fn paths_overlap(a: &Path, b: &Path) -> bool {
    a == b || a.starts_with(b) || b.starts_with(a)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default)]
    roots: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct FleetConfig {
    pub roots: Vec<PathBuf>,
}

pub fn load_config(env: &EnvPaths) -> Result<FleetConfig, String> {
    let path = env.config_file();
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FleetConfig::default());
        }
        Err(e) => return Err(format!("Failed to stat {}: {e}", path.display())),
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(format!(
            "Configuration file must be a regular file: {}",
            path.display()
        ));
    }

    let text =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    if text.trim().is_empty() {
        return Err(format!(
            "Configuration file {} is empty; expected 'roots: []'.",
            path.display()
        ));
    }

    let mut opts = serde_saphyr::Options::default();
    opts.strict_booleans = true;
    let raw: RawConfig = serde_saphyr::from_str_with_options(&text, opts)
        .map_err(|e| format!("Invalid configuration in {}: {e}", path.display()))?;

    let mut roots = Vec::with_capacity(raw.roots.len());
    for entry in raw.roots {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            return Err(format!(
                "Configuration {} contains an empty root path.",
                path.display()
            ));
        }
        if !trimmed.starts_with('/') && trimmed != "~" && !trimmed.starts_with("~/") {
            return Err(format!(
                "Root '{}' in {} must be an absolute path or start with '~/'.",
                entry,
                path.display()
            ));
        }
        let expanded = crate::fsx::normalize_lexical(&expand_user_path(trimmed, &env.home));
        roots.push(expanded);
    }

    Ok(FleetConfig { roots })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Target {
    Claude,
    Codex,
    Agy,
}

impl Target {
    pub const ALL: [Target; 3] = [Target::Claude, Target::Codex, Target::Agy];

    pub fn as_str(self) -> &'static str {
        match self {
            Target::Claude => "claude",
            Target::Codex => "codex",
            Target::Agy => "agy",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeKind {
    User,
    Project,
}

impl ScopeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScopeKind::User => "user",
            ScopeKind::Project => "project",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Scope {
    pub kind: ScopeKind,
    pub path: PathBuf,
    pub canonical_skills: PathBuf,
    pub canonical_agents: PathBuf,
    pub canonical_instructions: PathBuf,
    pub skill_links: Vec<(Target, PathBuf)>,
    pub agent_outputs: BTreeMap<Target, PathBuf>,
    pub instruction_links: Vec<(Target, PathBuf)>,
}

impl Scope {
    pub fn user(env: &EnvPaths) -> Self {
        let agents_root = env.user_agents_dir();
        let mut agent_outputs = BTreeMap::new();
        agent_outputs.insert(Target::Claude, env.claude_dir.join("agents"));
        agent_outputs.insert(Target::Codex, env.codex_dir.join("agents"));
        agent_outputs.insert(Target::Agy, env.gemini_dir.join("config").join("agents"));

        Self {
            kind: ScopeKind::User,
            path: env.home.clone(),
            canonical_skills: agents_root.join("skills"),
            canonical_agents: agents_root.join("overlord").join("agents"),
            canonical_instructions: agents_root.join("AGENTS.md"),
            skill_links: vec![
                (Target::Claude, env.claude_dir.join("skills")),
                (Target::Agy, env.gemini_dir.join("config").join("skills")),
            ],
            agent_outputs,
            instruction_links: vec![
                (Target::Claude, env.claude_dir.join("CLAUDE.md")),
                (Target::Codex, env.codex_dir.join("AGENTS.md")),
                (Target::Agy, env.gemini_dir.join("AGENTS.md")),
            ],
        }
    }

    pub fn project(project_root: PathBuf) -> Self {
        let dot_agents = project_root.join(".agents");
        let mut agent_outputs = BTreeMap::new();
        agent_outputs.insert(Target::Claude, project_root.join(".claude").join("agents"));
        agent_outputs.insert(Target::Codex, project_root.join(".codex").join("agents"));
        agent_outputs.insert(Target::Agy, dot_agents.join("agents"));

        Self {
            kind: ScopeKind::Project,
            canonical_skills: dot_agents.join("skills"),
            canonical_agents: dot_agents.join("overlord").join("agents"),
            canonical_instructions: project_root.join("AGENTS.md"),
            skill_links: vec![(Target::Claude, project_root.join(".claude").join("skills"))],
            agent_outputs,
            instruction_links: vec![(Target::Claude, project_root.join("CLAUDE.md"))],
            path: project_root,
        }
    }
}
