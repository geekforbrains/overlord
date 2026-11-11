use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use crate::config::EnvPaths;
use crate::fsx::{sha256_hex, write_atomic};
use crate::git::resolve_git_bin;
use crate::sync::run_fleet;

pub const LAUNCHD_LABEL: &str = "io.github.geekforbrains.overlord.watch";
pub const SYSTEMD_UNIT: &str = "overlord-watch.service";
const OWNERSHIP_MARKER: &str = "Managed by Overlord";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Linux,
}

impl Platform {
    pub fn current() -> Result<Self, String> {
        if cfg!(target_os = "macos") {
            Ok(Platform::MacOs)
        } else if cfg!(target_os = "linux") {
            Ok(Platform::Linux)
        } else {
            Err("Background service management is supported only on macOS and Linux.".to_string())
        }
    }
}

pub struct ServicePlan {
    pub exe_path: PathBuf,
    pub git_path: PathBuf,
    pub definition_path: PathBuf,
    pub receipt_path: PathBuf,
    pub stdout_log: Option<PathBuf>,
    pub stderr_log: Option<PathBuf>,
    pub rendered: String,
    pub digest: String,
}

pub fn build_service_plan(env: &EnvPaths, platform: Platform) -> Result<ServicePlan, String> {
    if is_root_user() {
        return Err("Refusing to manage a root service; run without sudo.".to_string());
    }
    let current_exe = env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|e| format!("Failed to resolve current executable path: {e}"))?;
    let git_path = resolve_git_bin();

    let mut path_dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = current_exe.parent() {
        push_unique(&mut path_dirs, dir.to_path_buf());
    }
    if let Some(dir) = git_path.parent()
        && !dir.as_os_str().is_empty()
    {
        push_unique(&mut path_dirs, dir.to_path_buf());
    }
    for std_dir in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push_unique(&mut path_dirs, PathBuf::from(std_dir));
    }
    let deterministic_path = env::join_paths(&path_dirs)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".to_string());

    let mut env_vars = BTreeMap::new();
    env_vars.insert("HOME".to_string(), env.home.display().to_string());
    env_vars.insert("PATH".to_string(), deterministic_path);
    env_vars.insert(
        "OVERLORD_GIT_EXECUTABLE".to_string(),
        git_path.display().to_string(),
    );
    env_vars.insert("OVERLORD_SERVICE".to_string(), "1".to_string());
    env_vars.insert(
        "OVERLORD_SERVICE_VERSION".to_string(),
        env!("CARGO_PKG_VERSION").to_string(),
    );
    for optional in [
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "GEMINI_DIR",
        "XDG_STATE_HOME",
        "XDG_CONFIG_HOME",
    ] {
        if let Ok(val) = env::var(optional)
            && !val.trim().is_empty()
        {
            env_vars.insert(optional.to_string(), val);
        }
    }

    match platform {
        Platform::MacOs => {
            let def_path = env
                .home
                .join("Library")
                .join("LaunchAgents")
                .join(format!("{LAUNCHD_LABEL}.plist"));
            let receipt_path = env
                .home
                .join("Library")
                .join("Application Support")
                .join("Overlord")
                .join("service.json");
            let log_dir = env.home.join("Library").join("Logs").join("Overlord");
            let stdout_log = log_dir.join("watch.log");
            let stderr_log = log_dir.join("watch-error.log");
            let rendered = render_launchd_plist(&current_exe, &env_vars, &stdout_log, &stderr_log);
            let digest = sha256_hex(rendered.as_bytes());
            Ok(ServicePlan {
                exe_path: current_exe,
                git_path,
                definition_path: def_path,
                receipt_path,
                stdout_log: Some(stdout_log),
                stderr_log: Some(stderr_log),
                rendered,
                digest,
            })
        }
        Platform::Linux => {
            let def_path = env
                .config_home
                .join("systemd")
                .join("user")
                .join(SYSTEMD_UNIT);
            let receipt_path = env.state_dir.join("service.json");
            let rendered = render_systemd_unit(&current_exe, &env_vars);
            let digest = sha256_hex(rendered.as_bytes());
            Ok(ServicePlan {
                exe_path: current_exe,
                git_path,
                definition_path: def_path,
                receipt_path,
                stdout_log: None,
                stderr_log: None,
                rendered,
                digest,
            })
        }
    }
}

pub fn render_launchd_plist(
    exe: &Path,
    env_vars: &BTreeMap<String, String>,
    stdout_log: &Path,
    stderr_log: &Path,
) -> String {
    let mut env_xml = String::new();
    for (k, v) in env_vars {
        env_xml.push_str(&format!(
            "    <key>{}</key>\n    <string>{}</string>\n",
            xml_escape(k),
            xml_escape(v)
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!-- {OWNERSHIP_MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>watch</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
{env_xml}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>{out}</string>
  <key>StandardErrorPath</key>
  <string>{err}</string>
</dict>
</plist>
"#,
        exe = xml_escape(&exe.display().to_string()),
        out = xml_escape(&stdout_log.display().to_string()),
        err = xml_escape(&stderr_log.display().to_string()),
    )
}

pub fn render_systemd_unit(exe: &Path, env_vars: &BTreeMap<String, String>) -> String {
    let mut env_lines = String::new();
    for (k, v) in env_vars {
        env_lines.push_str(&format!(
            "Environment=\"{}={}\"\n",
            systemd_escape(k),
            systemd_escape(v)
        ));
    }
    format!(
        r#"# {OWNERSHIP_MARKER}
[Unit]
Description=Overlord background synchronization watcher
After=default.target

[Service]
Type=simple
ExecStart="{}" watch
Restart=on-failure
RestartSec=2
TimeoutStopSec=120
{env_lines}
[Install]
WantedBy=default.target
"#,
        systemd_escape(&exe.display().to_string())
    )
}

pub fn service_install(env: &EnvPaths, dry_run: bool) -> Result<(), String> {
    let platform = Platform::current()?;
    let check_report = run_fleet(env, "check", true, true)?;
    if !check_report.ok {
        return Err(
            "Fleet baseline is not clean; run 'overlord sync' and 'overlord check' before installing the service."
                .to_string(),
        );
    }

    let plan = build_service_plan(env, platform)?;
    ensure_not_foreign_definition(&plan.definition_path)?;

    if dry_run {
        println!("service install (dry-run): ok");
        print_plan_summary(&plan);
        println!("--- rendered definition ---");
        print!("{}", plan.rendered);
        return Ok(());
    }

    if let Some(stdout) = &plan.stdout_log
        && let Some(parent) = stdout.parent()
    {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create log directory {}: {e}", parent.display()))?;
    }

    let receipt_json = serde_json::json!({
        "version": 3,
        "executable": plan.exe_path.display().to_string(),
        "definitionPath": plan.definition_path.display().to_string(),
        "definitionDigest": plan.digest,
    });
    let mut receipt_bytes = serde_json::to_vec_pretty(&receipt_json)
        .map_err(|e| format!("Failed to serialize service receipt: {e}"))?;
    receipt_bytes.push(b'\n');

    match platform {
        Platform::MacOs => {
            let domain = format!("gui/{}", current_uid());
            let service_target = format!("{domain}/{LAUNCHD_LABEL}");
            if launchd_is_loaded(&service_target) {
                let _ = Command::new("launchctl")
                    .args(["bootout", &service_target])
                    .output();
                wait_launchd_unloaded(&service_target);
            }

            write_atomic(&plan.definition_path, plan.rendered.as_bytes(), Some(0o600))?;
            write_atomic(&plan.receipt_path, &receipt_bytes, Some(0o600))?;

            // Enable BEFORE bootstrap so a previously disabled LaunchAgent label can load cleanly.
            let _ = Command::new("launchctl")
                .args(["enable", &service_target])
                .output();
            bootstrap_launchd_with_retry(&domain, &plan.definition_path)?;
            let _ = Command::new("launchctl")
                .args(["kickstart", "-k", &service_target])
                .output();
        }
        Platform::Linux => {
            write_atomic(&plan.definition_path, plan.rendered.as_bytes(), Some(0o600))?;
            write_atomic(&plan.receipt_path, &receipt_bytes, Some(0o600))?;
            run_systemctl(&["daemon-reload"])?;
            run_systemctl(&["enable", "--now", SYSTEMD_UNIT])?;
            run_systemctl(&["restart", SYSTEMD_UNIT])?;
        }
    }

    println!("service install: ok");
    print_plan_summary(&plan);
    Ok(())
}

pub fn service_uninstall(env: &EnvPaths) -> Result<(), String> {
    let platform = Platform::current()?;
    let plan = build_service_plan(env, platform)?;

    if fs::symlink_metadata(&plan.definition_path).is_err() {
        let _ = fs::remove_file(&plan.receipt_path);
        println!("service uninstall: ok (not installed)");
        return Ok(());
    }
    ensure_owned_definition(&plan.definition_path)?;

    match platform {
        Platform::MacOs => {
            let domain = format!("gui/{}", current_uid());
            let service_target = format!("{domain}/{LAUNCHD_LABEL}");
            if launchd_is_loaded(&service_target) {
                let _ = Command::new("launchctl")
                    .args(["bootout", &service_target])
                    .output();
                wait_launchd_unloaded(&service_target);
            }
            let _ = Command::new("launchctl")
                .args(["disable", &service_target])
                .output();
            fs::remove_file(&plan.definition_path)
                .map_err(|e| format!("Failed to remove {}: {e}", plan.definition_path.display()))?;
            let _ = fs::remove_file(&plan.receipt_path);
        }
        Platform::Linux => {
            let _ = run_systemctl(&["disable", "--now", SYSTEMD_UNIT]);
            fs::remove_file(&plan.definition_path)
                .map_err(|e| format!("Failed to remove {}: {e}", plan.definition_path.display()))?;
            let _ = fs::remove_file(&plan.receipt_path);
            let _ = run_systemctl(&["daemon-reload"]);
        }
    }

    println!("service uninstall: ok");
    println!("  removed {}", plan.definition_path.display());
    Ok(())
}

pub fn service_status(env: &EnvPaths) -> Result<bool, String> {
    let platform = Platform::current()?;
    let plan = build_service_plan(env, platform)?;

    let def_state = match fs::read_to_string(&plan.definition_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "absent",
        Err(_) => "unreadable",
        Ok(existing) => {
            if !existing.contains(OWNERSHIP_MARKER) {
                "foreign-collision"
            } else if existing == plan.rendered {
                "current"
            } else {
                "stale-or-modified"
            }
        }
    };

    match platform {
        Platform::MacOs => {
            let service_target = format!("gui/{}/{LAUNCHD_LABEL}", current_uid());
            let out = Command::new("launchctl")
                .args(["print", &service_target])
                .output();
            let (loaded, active) = match out {
                Ok(o) if o.status.success() => {
                    let text = String::from_utf8_lossy(&o.stdout);
                    let running = text.contains("state = running");
                    (true, running)
                }
                _ => (false, false),
            };
            let healthy = def_state == "current" && loaded && active;
            println!(
                "service status: {}",
                if healthy { "ok" } else { "attention-required" }
            );
            println!("  manager: launchd ({LAUNCHD_LABEL})");
            println!(
                "  definition: {} ({def_state})",
                plan.definition_path.display()
            );
            println!("  desired binary: {}", plan.exe_path.display());
            println!("  loaded: {}", yes_no(loaded));
            println!("  active: {}", yes_no(active));
            Ok(healthy)
        }
        Platform::Linux => {
            let active = Command::new("systemctl")
                .args(["--user", "is-active", "--quiet", SYSTEMD_UNIT])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            let enabled = Command::new("systemctl")
                .args(["--user", "is-enabled", "--quiet", SYSTEMD_UNIT])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            let healthy = def_state == "current" && active && enabled;
            println!(
                "service status: {}",
                if healthy { "ok" } else { "attention-required" }
            );
            println!("  manager: systemd --user ({SYSTEMD_UNIT})");
            println!(
                "  definition: {} ({def_state})",
                plan.definition_path.display()
            );
            println!("  desired binary: {}", plan.exe_path.display());
            println!("  enabled: {}", yes_no(enabled));
            println!("  active: {}", yes_no(active));
            Ok(healthy)
        }
    }
}

pub fn service_logs(env: &EnvPaths) -> Result<(), String> {
    let platform = Platform::current()?;
    let plan = build_service_plan(env, platform)?;
    match platform {
        Platform::MacOs => {
            for (label, path_opt) in [("stdout", &plan.stdout_log), ("stderr", &plan.stderr_log)] {
                if let Some(path) = path_opt {
                    println!("=== {label}: {} ===", path.display());
                    match read_tail(path, 64 * 1024) {
                        Ok(Some(text)) if !text.is_empty() => {
                            print!("{text}");
                            if !text.ends_with('\n') {
                                println!();
                            }
                        }
                        Ok(_) => println!("(empty)"),
                        Err(e) => println!("(unavailable: {e})"),
                    }
                }
            }
            Ok(())
        }
        Platform::Linux => {
            let out = Command::new("journalctl")
                .args(["--user", "-u", SYSTEMD_UNIT, "-n", "200", "--no-pager"])
                .output()
                .map_err(|e| format!("Failed to invoke journalctl: {e}"))?;
            print!("{}", String::from_utf8_lossy(&out.stdout));
            Ok(())
        }
    }
}

fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<Option<String>> {
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    if len > max_bytes {
        file.seek(SeekFrom::Start(len - max_bytes))?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

fn ensure_not_foreign_definition(path: &Path) -> Result<(), String> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "Refusing to overwrite symlinked service file: {}",
                path.display()
            ));
        }
        let text = fs::read_to_string(path)
            .map_err(|e| format!("Failed to read existing {}: {e}", path.display()))?;
        if !text.contains(OWNERSHIP_MARKER) {
            return Err(format!(
                "Refusing to overwrite existing unowned service definition {} (missing '{OWNERSHIP_MARKER}' marker).",
                path.display()
            ));
        }
    }
    Ok(())
}

fn ensure_owned_definition(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to inspect {}: {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!(
            "Refusing to remove symlinked service file: {}",
            path.display()
        ));
    }
    let text =
        fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    if !text.contains(OWNERSHIP_MARKER) {
        return Err(format!(
            "Refusing to remove unowned service definition {} (missing '{OWNERSHIP_MARKER}' marker).",
            path.display()
        ));
    }
    Ok(())
}

fn launchd_is_loaded(service_target: &str) -> bool {
    Command::new("launchctl")
        .args(["print", service_target])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn wait_launchd_unloaded(service_target: &str) {
    for _ in 0..40 {
        if !launchd_is_loaded(service_target) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn bootstrap_launchd_with_retry(domain: &str, plist: &Path) -> Result<(), String> {
    let delays = [0u64, 100, 250, 500];
    let plist_str = plist.display().to_string();
    let mut last_err = String::new();
    for delay in delays {
        if delay > 0 {
            thread::sleep(Duration::from_millis(delay));
        }
        let out = Command::new("launchctl")
            .args(["bootstrap", domain, &plist_str])
            .output()
            .map_err(|e| format!("Failed to invoke launchctl bootstrap: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        last_err = stderr.clone();
        if !stderr.contains("Bootstrap failed: 5") {
            break;
        }
    }
    Err(format!("launchctl bootstrap failed: {last_err}"))
}

fn run_systemctl(args: &[&str]) -> Result<(), String> {
    let mut full = vec!["--user"];
    full.extend_from_slice(args);
    let out = Command::new("systemctl")
        .args(&full)
        .output()
        .map_err(|e| format!("Failed to run systemctl --user {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "systemctl --user {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn print_plan_summary(plan: &ServicePlan) {
    println!("  binary: {} watch", plan.exe_path.display());
    println!("  git: {}", plan.git_path.display());
    println!("  definition: {}", plan.definition_path.display());
    if let Some(out) = &plan.stdout_log {
        println!("  stdout log: {}", out.display());
    }
    if let Some(err) = &plan.stderr_log {
        println!("  stderr log: {}", err.display());
    }
}

fn yes_no(v: bool) -> &'static str {
    if v { "yes" } else { "no" }
}

fn push_unique(vec: &mut Vec<PathBuf>, item: PathBuf) {
    if !vec.contains(&item) {
        vec.push(item);
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn systemd_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn current_uid() -> u32 {
    Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<u32>()
                .ok()
        })
        .unwrap_or(501)
}

fn is_root_user() -> bool {
    current_uid() == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_owned_plist_and_systemd_unit() {
        let mut env_vars = BTreeMap::new();
        env_vars.insert("HOME".to_string(), "/Users/test".to_string());
        let plist = render_launchd_plist(
            Path::new("/Users/test/.local/bin/overlord"),
            &env_vars,
            Path::new("/Users/test/Library/Logs/Overlord/watch.log"),
            Path::new("/Users/test/Library/Logs/Overlord/watch-error.log"),
        );
        assert!(plist.contains("Managed by Overlord"));
        assert!(plist.contains(LAUNCHD_LABEL));
        assert!(plist.contains("<string>watch</string>"));

        let unit = render_systemd_unit(Path::new("/home/test/.local/bin/overlord"), &env_vars);
        assert!(unit.contains("Managed by Overlord"));
        assert!(unit.contains("ExecStart=\"/home/test/.local/bin/overlord\" watch"));
    }
}
