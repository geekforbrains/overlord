use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use signal_hook::consts::signal::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

use crate::config::{EnvPaths, load_config};
use crate::scope::discover_scopes;
use crate::state::acquire_lock;
use crate::sync::run_fleet;

const DEBOUNCE: Duration = Duration::from_millis(500);
const RESCAN_TICK: Duration = Duration::from_secs(60);

enum LoopMsg {
    Fs,
    Stop,
}

pub fn run_watch(env: &EnvPaths) -> Result<(), String> {
    let service_mode = env::var("OVERLORD_SERVICE").ok().as_deref() == Some("1");
    let _watch_lock = acquire_lock(&env.state_dir, "watch.lock")?;

    let (tx, rx) = mpsc::channel::<LoopMsg>();

    let mut signals = Signals::new([SIGINT, SIGTERM])
        .map_err(|e| format!("Failed to register signal handlers: {e}"))?;
    let sig_tx = tx.clone();
    std::thread::spawn(move || {
        if signals.forever().next().is_some() {
            let _ = sig_tx.send(LoopMsg::Stop);
        }
    });

    log_line(service_mode, "watch: started");

    // Initial full sync
    run_cycle(env, service_mode, true);

    let fs_tx = tx.clone();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res
                && should_trigger_sync(&event)
            {
                let _ = fs_tx.send(LoopMsg::Fs);
            }
        })
        .map_err(|e| format!("Failed to initialize filesystem watcher: {e}"))?;

    let mut watched_set = BTreeSet::new();
    refresh_watches(env, &mut watcher, &mut watched_set);

    let mut last_rescan = Instant::now();
    loop {
        let elapsed = last_rescan.elapsed();
        let wait = RESCAN_TICK.saturating_sub(elapsed);
        match rx.recv_timeout(wait) {
            Ok(LoopMsg::Stop) => {
                log_line(service_mode, "watch: stopped");
                return Ok(());
            }
            Ok(LoopMsg::Fs) => {
                // Debounce quiet window
                let mut deadline = Instant::now() + DEBOUNCE;
                loop {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    match rx.recv_timeout(deadline - now) {
                        Ok(LoopMsg::Stop) => {
                            log_line(service_mode, "watch: stopped");
                            return Ok(());
                        }
                        Ok(LoopMsg::Fs) => {
                            deadline = Instant::now() + DEBOUNCE;
                        }
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return Ok(()),
                    }
                }
                run_cycle(env, service_mode, false);
                refresh_watches(env, &mut watcher, &mut watched_set);
                last_rescan = Instant::now();
            }
            Err(RecvTimeoutError::Timeout) => {
                run_cycle(env, service_mode, false);
                refresh_watches(env, &mut watcher, &mut watched_set);
                last_rescan = Instant::now();
            }
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

fn should_trigger_sync(event: &Event) -> bool {
    if event.kind.is_access() {
        return false;
    }
    if event.paths.is_empty() {
        return false;
    }
    event.paths.iter().any(|p| !is_noise_path(p))
}

fn is_noise_path(path: &Path) -> bool {
    for comp in path.components() {
        let s = comp.as_os_str().to_string_lossy();
        if s == ".git" || s == ".DS_Store" || s.starts_with(".overlord-") || s.starts_with("._") {
            return true;
        }
    }
    false
}

fn run_cycle(env: &EnvPaths, service_mode: bool, always_log: bool) {
    match run_fleet(env, "watch-sync", false, false) {
        Ok(report) => {
            if always_log
                || !report.actions.is_empty()
                || !report.diagnostics.is_empty()
                || report.git_commit.is_some()
            {
                log_line(
                    service_mode,
                    &format!(
                        "watch: synced (scopes={}, defs={}, actions={}, issues={}{})",
                        report.summary.scopes,
                        report.summary.definitions,
                        report.actions.len(),
                        report.diagnostics.len(),
                        report
                            .git_commit
                            .as_ref()
                            .map(|c| format!(", commit={c}"))
                            .unwrap_or_default()
                    ),
                );
                for act in &report.actions {
                    log_line(
                        service_mode,
                        &format!("  [done] {} {}: {}", act.action, act.name, act.path),
                    );
                }
                for diag in &report.diagnostics {
                    log_line(
                        service_mode,
                        &format!("  [issue] {}: {}", diag.code, diag.message),
                    );
                }
            }
        }
        Err(err) => {
            log_line(service_mode, &format!("watch: error: {err}"));
        }
    }
}

fn refresh_watches(
    env: &EnvPaths,
    watcher: &mut RecommendedWatcher,
    current: &mut BTreeSet<(PathBuf, bool)>,
) {
    let mut desired: BTreeSet<(PathBuf, bool)> = BTreeSet::new();

    if let Ok(cfg) = load_config(env) {
        for root in &cfg.roots {
            if root.is_dir() {
                desired.insert((root.clone(), false));
            }
        }
        let mut dummy_diags = Vec::new();
        let scopes = discover_scopes(env, &cfg, &mut dummy_diags);
        for s in scopes {
            add_if_dir(&mut desired, &s.path, false);
            add_if_dir(&mut desired, &s.canonical_skills, true);
            add_if_dir(&mut desired, &s.canonical_agents, true);
            if let Some(overlord_dir) = s.canonical_agents.parent() {
                add_if_dir(&mut desired, overlord_dir, false);
            }
            for (_, link_root) in &s.skill_links {
                add_if_dir(&mut desired, link_root, false);
                if let Some(parent) = link_root.parent() {
                    add_if_dir(&mut desired, parent, false);
                }
            }
            for dir in s.agent_outputs.values() {
                add_if_dir(&mut desired, dir, false);
                if let Some(parent) = dir.parent() {
                    add_if_dir(&mut desired, parent, false);
                }
            }
            for (_, link_file) in &s.instruction_links {
                if let Some(parent) = link_file.parent() {
                    add_if_dir(&mut desired, parent, false);
                }
            }
        }
    }

    add_if_dir(&mut desired, &env.user_agents_dir(), false);

    for old in current.difference(&desired).cloned().collect::<Vec<_>>() {
        let _ = watcher.unwatch(&old.0);
        current.remove(&old);
    }
    for item in desired.difference(current).cloned().collect::<Vec<_>>() {
        let mode = if item.1 {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        if watcher.watch(&item.0, mode).is_ok() {
            current.insert(item);
        }
    }
}

fn add_if_dir(set: &mut BTreeSet<(PathBuf, bool)>, path: &Path, recursive: bool) {
    if let Ok(m) = fs::symlink_metadata(path)
        && !m.file_type().is_symlink()
        && m.is_dir()
    {
        set.insert((path.to_path_buf(), recursive));
    }
}

fn log_line(service_mode: bool, msg: &str) {
    if service_mode {
        let ts = unix_timestamp_iso();
        println!("{ts} {msg}");
    } else {
        println!("{msg}");
    }
}

fn unix_timestamp_iso() -> String {
    // Simple UTC ISO-8601 timestamp using civil calendar math (no extra crate needed)
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m as u32, d as u32)
}
