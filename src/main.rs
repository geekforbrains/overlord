mod agent;
mod config;
mod fsx;
mod git;
mod instructions;
mod report;
mod scope;
mod service;
mod skills;
mod state;
mod sync;
mod watch;

use std::process::ExitCode;

use lexopt::prelude::*;

use crate::config::EnvPaths;
use crate::service::{service_install, service_logs, service_status, service_uninstall};
use crate::sync::{run_fleet, run_init};
use crate::watch::run_watch;

const HELP: &str = "\
Overlord — synchronize skills, custom agents, and AGENTS.md across Claude Code, Codex, and Antigravity (agy)

Usage:
  overlord init [--json]
  overlord status [--json]
  overlord check [--json]
  overlord sync [--dry-run] [--json]
  overlord watch
  overlord service <install [--dry-run] | status | logs | uninstall>
  overlord --help | --version

Commands:
  init      Initialize ~/.agents repository, overlord.yaml, and bundled skill
  status    Inspect user and project scopes without mutating files (exits 0)
  check     Inspect user and project scopes and exit 1 if anything needs attention
  sync      Synchronize skills, custom agents, and AGENTS.md links across scopes
  watch     Keep the fleet synchronized in the foreground until interrupted
  service   Manage the per-user background watcher (launchd on macOS, systemd on Linux)

Options:
  --dry-run   Preview actions without writing files (supported by 'sync' and 'service install')
  --json      Emit machine-readable JSON output (supported by 'init', 'status', 'check', 'sync')
  -h, --help  Show help
  -V, --version  Show version
";

enum Cmd {
    Help,
    Version,
    Init { json: bool },
    Status { json: bool },
    Check { json: bool },
    Sync { dry_run: bool, json: bool },
    Watch,
    ServiceInstall { dry_run: bool },
    ServiceStatus,
    ServiceLogs,
    ServiceUninstall,
}

fn parse_cli() -> Result<Cmd, String> {
    let mut parser = lexopt::Parser::from_env();
    let mut subcmd: Option<String> = None;
    let mut service_subcmd: Option<String> = None;
    let mut dry_run = false;
    let mut json = false;

    while let Some(arg) = parser.next().map_err(|e| e.to_string())? {
        match arg {
            Short('h') | Long("help") => return Ok(Cmd::Help),
            Short('V') | Long("version") => return Ok(Cmd::Version),
            Long("dry-run") => dry_run = true,
            Long("json") => json = true,
            Value(val) => {
                let s = val
                    .string()
                    .map_err(|_| "Invalid UTF-8 argument.".to_string())?;
                if subcmd.is_none() {
                    subcmd = Some(s);
                } else if subcmd.as_deref() == Some("service") && service_subcmd.is_none() {
                    service_subcmd = Some(s);
                } else {
                    return Err(format!("Unexpected argument '{s}'."));
                }
            }
            _ => return Err(format!("Unexpected option: {}", arg.unexpected())),
        }
    }

    match subcmd.as_deref() {
        None | Some("help") => Ok(Cmd::Help),
        Some("init") => {
            if dry_run {
                return Err("'overlord init' does not support --dry-run.".to_string());
            }
            Ok(Cmd::Init { json })
        }
        Some("status") => {
            if dry_run {
                return Err("'overlord status' is already read-only; omit --dry-run.".to_string());
            }
            Ok(Cmd::Status { json })
        }
        Some("check") => {
            if dry_run {
                return Err("'overlord check' is already read-only; omit --dry-run.".to_string());
            }
            Ok(Cmd::Check { json })
        }
        Some("sync") => Ok(Cmd::Sync { dry_run, json }),
        Some("watch") => {
            if dry_run || json {
                return Err("'overlord watch' does not support --dry-run or --json.".to_string());
            }
            Ok(Cmd::Watch)
        }
        Some("service") => {
            if json {
                return Err(
                    "'overlord service' commands are human-only and do not support --json."
                        .to_string(),
                );
            }
            match service_subcmd.as_deref() {
                Some("install") => Ok(Cmd::ServiceInstall { dry_run }),
                Some("status") if !dry_run => Ok(Cmd::ServiceStatus),
                Some("logs") if !dry_run => Ok(Cmd::ServiceLogs),
                Some("uninstall") if !dry_run => Ok(Cmd::ServiceUninstall),
                Some(other) => Err(format!(
                    "Unsupported service subcommand or flag combination for '{other}'."
                )),
                None => Err(
                    "Missing service subcommand (expected: install, status, logs, uninstall)."
                        .to_string(),
                ),
            }
        }
        Some(other) => Err(format!("Unknown command '{other}'. Run 'overlord --help'.")),
    }
}

fn main() -> ExitCode {
    let cmd = match parse_cli() {
        Ok(c) => c,
        Err(err) => {
            eprintln!("error: {err}");
            return ExitCode::from(2);
        }
    };

    match cmd {
        Cmd::Help => {
            print!("{HELP}");
            ExitCode::SUCCESS
        }
        Cmd::Version => {
            println!("overlord {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Cmd::Init { json } => match EnvPaths::from_env().and_then(|env| run_init(&env)) {
            Ok(report) => {
                if let Err(e) = report.print(json) {
                    eprintln!("error: {e}");
                    return ExitCode::FAILURE;
                }
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
        Cmd::Status { json } => {
            match EnvPaths::from_env().and_then(|env| run_fleet(&env, "status", true, false)) {
                Ok(report) => {
                    if let Err(e) = report.print(json) {
                        eprintln!("error: {e}");
                        return ExitCode::FAILURE;
                    }
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("error: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Cmd::Check { json } => {
            match EnvPaths::from_env().and_then(|env| run_fleet(&env, "check", true, true)) {
                Ok(report) => {
                    if let Err(e) = report.print(json) {
                        eprintln!("error: {e}");
                        return ExitCode::FAILURE;
                    }
                    if report.ok {
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::FAILURE
                    }
                }
                Err(e) => {
                    eprintln!("error: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Cmd::Sync { dry_run, json } => {
            match EnvPaths::from_env().and_then(|env| run_fleet(&env, "sync", dry_run, false)) {
                Ok(report) => {
                    if let Err(e) = report.print(json) {
                        eprintln!("error: {e}");
                        return ExitCode::FAILURE;
                    }
                    if report.needs_attention() {
                        ExitCode::FAILURE
                    } else {
                        ExitCode::SUCCESS
                    }
                }
                Err(e) => {
                    eprintln!("error: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Cmd::Watch => match EnvPaths::from_env().and_then(|env| run_watch(&env)) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
        Cmd::ServiceInstall { dry_run } => {
            match EnvPaths::from_env().and_then(|env| service_install(&env, dry_run)) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("error: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Cmd::ServiceStatus => match EnvPaths::from_env().and_then(|env| service_status(&env)) {
            Ok(true) => ExitCode::SUCCESS,
            Ok(false) => ExitCode::FAILURE,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
        Cmd::ServiceLogs => match EnvPaths::from_env().and_then(|env| service_logs(&env)) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
        Cmd::ServiceUninstall => match EnvPaths::from_env().and_then(|env| service_uninstall(&env))
        {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
    }
}
