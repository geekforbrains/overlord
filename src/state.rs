use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config::Target;
use crate::fsx::write_atomic;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentRecord {
    pub canonical_hash: String,
    #[serde(default)]
    pub outputs: BTreeMap<String, String>,
}

impl AgentRecord {
    pub fn output_hash(&self, target: Target) -> Option<&str> {
        self.outputs.get(target.as_str()).map(String::as_str)
    }

    pub fn set_output_hash(&mut self, target: Target, hash: String) {
        self.outputs.insert(target.as_str().to_string(), hash);
    }

    pub fn remove_output_hash(&mut self, target: Target) {
        self.outputs.remove(target.as_str());
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StateFile {
    #[serde(default = "default_version")]
    pub version: u32,
    /// Map of `scope_path -> (agent_name -> AgentRecord)`
    #[serde(default)]
    pub agents: BTreeMap<String, BTreeMap<String, AgentRecord>>,
}

fn default_version() -> u32 {
    1
}

impl StateFile {
    pub fn load(state_dir: &Path) -> Result<Self, String> {
        let path = state_dir.join("state.json");
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self {
                    version: 1,
                    agents: BTreeMap::new(),
                });
            }
            Err(e) => return Err(format!("Failed to read {}: {e}", path.display())),
        };
        serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid state file {}: {e}", path.display()))
    }

    pub fn save(&self, state_dir: &Path) -> Result<(), String> {
        let path = state_dir.join("state.json");
        let mut bytes = serde_json::to_vec_pretty(self)
            .map_err(|e| format!("Failed to serialize state: {e}"))?;
        bytes.push(b'\n');
        write_atomic(&path, &bytes, Some(0o600))
    }

    pub fn get_agent(&self, scope_path: &Path, name: &str) -> Option<&AgentRecord> {
        let key = scope_path.display().to_string();
        self.agents.get(&key)?.get(name)
    }

    pub fn set_agent(&mut self, scope_path: &Path, name: String, record: AgentRecord) {
        let key = scope_path.display().to_string();
        self.agents.entry(key).or_default().insert(name, record);
    }

    pub fn remove_agent(&mut self, scope_path: &Path, name: &str) {
        let key = scope_path.display().to_string();
        if let Some(scope_map) = self.agents.get_mut(&key) {
            scope_map.remove(name);
            if scope_map.is_empty() {
                self.agents.remove(&key);
            }
        }
    }
}

pub struct FileLockGuard {
    _file: File,
}

pub fn acquire_lock(state_dir: &Path, lock_name: &str) -> Result<FileLockGuard, String> {
    fs::create_dir_all(state_dir).map_err(|e| {
        format!(
            "Failed to create state directory {}: {e}",
            state_dir.display()
        )
    })?;
    let path = state_dir.join(lock_name);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("Failed to open lock file {}: {e}", path.display()))?;

    match file.try_lock() {
        Ok(()) => Ok(FileLockGuard { _file: file }),
        Err(TryLockError::WouldBlock) => Err(format!(
            "Another Overlord process holds the lock ({}).",
            path.display()
        )),
        Err(TryLockError::Error(e)) => Err(format!("Failed to lock {}: {e}", path.display())),
    }
}
