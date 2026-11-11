use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::Duration;

use tempfile::TempDir;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_overlord")
}

fn run_overlord(home: &Path, args: &[&str]) -> Output {
    Command::new(bin())
        .args(args)
        .env("HOME", home)
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("CODEX_HOME")
        .env_remove("GEMINI_DIR")
        .env_remove("XDG_STATE_HOME")
        .env_remove("XDG_CONFIG_HOME")
        .output()
        .expect("run overlord")
}

fn write_skill(dir: &Path, name: &str, body: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: Skill {name}\n---\n\n{body}\n"),
    )
    .unwrap();
}

#[test]
fn init_and_skill_symlinks_across_claude_codex_and_agy() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    let out = run_overlord(home, &["init", "--json"]);
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["ok"], true);
    assert!(doc["gitCommit"].is_string());

    // Configure discovery root
    let projects = home.join("Projects");
    fs::create_dir_all(&projects).unwrap();
    fs::write(
        home.join(".agents/overlord/overlord.yaml"),
        "roots:\n  - ~/Projects\n",
    )
    .unwrap();

    // User-scope skill + legacy copied Claude skill + Claude .trash preservation
    write_skill(
        &home.join(".agents/skills/demo-user"),
        "demo-user",
        "Hello v1",
    );
    write_skill(
        &home.join(".claude/skills/demo-user"),
        "demo-user",
        "Hello v1",
    );
    fs::create_dir_all(home.join(".claude/skills/.trash/old")).unwrap();
    fs::create_dir_all(home.join(".claude/skills/synced/cloud")).unwrap();

    // Project with canonical skill + legacy copied Claude skill + nested 2-level project
    let proj_a = projects.join("alpha");
    write_skill(
        &proj_a.join(".agents/skills/proj-skill"),
        "proj-skill",
        "Proj body",
    );
    write_skill(
        &proj_a.join(".claude/skills/proj-skill"),
        "proj-skill",
        "Proj body",
    );

    let nested_proj = projects.join("group/nested");
    write_skill(
        &nested_proj.join(".agents/skills/deep-skill"),
        "deep-skill",
        "Deep",
    );

    // Before sync, check should exit 1 (pending actions)
    let chk_before = run_overlord(home, &["check"]);
    assert!(!chk_before.status.success());

    // Sync converts copies to symlinks and links user skills into ~/.gemini/config/skills
    let sync_out = run_overlord(home, &["sync", "--json"]);
    assert!(
        sync_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&sync_out.stderr)
    );
    let sync_doc: serde_json::Value = serde_json::from_slice(&sync_out.stdout).unwrap();
    assert_eq!(sync_doc["ok"], true);
    assert!(sync_doc["gitCommit"].is_string());

    // Verify user symlinks for Claude and agy
    let claude_user_link = home.join(".claude/skills/demo-user");
    let agy_user_link = home.join(".gemini/config/skills/demo-user");
    assert!(
        fs::symlink_metadata(&claude_user_link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        fs::symlink_metadata(&agy_user_link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::canonicalize(&claude_user_link).unwrap(),
        fs::canonicalize(home.join(".agents/skills/demo-user")).unwrap()
    );
    assert_eq!(
        fs::canonicalize(&agy_user_link).unwrap(),
        fs::canonicalize(home.join(".agents/skills/demo-user")).unwrap()
    );

    // Verify Claude's .trash and synced folders were preserved untouched
    assert!(home.join(".claude/skills/.trash/old").is_dir());
    assert!(home.join(".claude/skills/synced/cloud").is_dir());

    // Verify project relative symlink
    let proj_link = proj_a.join(".claude/skills/proj-skill");
    assert!(
        fs::symlink_metadata(&proj_link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_link(&proj_link).unwrap(),
        PathBuf::from("../../.agents/skills/proj-skill")
    );
    assert!(
        fs::symlink_metadata(nested_proj.join(".claude/skills/deep-skill"))
            .unwrap()
            .file_type()
            .is_symlink()
    );

    // Adopt a new skill created natively in ~/.gemini/config/skills
    write_skill(
        &home.join(".gemini/config/skills/from-agy"),
        "from-agy",
        "Created in agy",
    );
    let sync2 = run_overlord(home, &["sync"]);
    assert!(sync2.status.success());
    assert!(home.join(".agents/skills/from-agy/SKILL.md").is_file());
    assert!(
        fs::symlink_metadata(home.join(".gemini/config/skills/from-agy"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        fs::symlink_metadata(home.join(".claude/skills/from-agy"))
            .unwrap()
            .file_type()
            .is_symlink()
    );

    // Delete canonical skill -> stale links in Claude and agy are pruned, foreign symlink is kept
    let external = tmp.path().join("external-skill");
    write_skill(&external, "external-skill", "Outside");
    symlink(&external, home.join(".claude/skills/external-skill")).unwrap();
    fs::remove_dir_all(home.join(".agents/skills/from-agy")).unwrap();

    let sync3 = run_overlord(home, &["sync"]);
    assert!(sync3.status.success());
    assert!(fs::symlink_metadata(home.join(".claude/skills/from-agy")).is_err());
    assert!(fs::symlink_metadata(home.join(".gemini/config/skills/from-agy")).is_err());
    assert!(fs::symlink_metadata(home.join(".claude/skills/external-skill")).is_ok());

    let chk_after = run_overlord(home, &["check"]);
    assert!(
        chk_after.status.success(),
        "stdout: {}",
        String::from_utf8_lossy(&chk_after.stdout)
    );
}

#[test]
fn agents_three_way_render_adopt_capture_and_conflict() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();
    assert!(run_overlord(home, &["init"]).status.success());

    let projects = home.join("Projects");
    let repo = projects.join("app");
    fs::create_dir_all(repo.join(".agents/overlord/agents")).unwrap();
    fs::write(
        home.join(".agents/overlord/overlord.yaml"),
        "roots:\n  - ~/Projects\n",
    )
    .unwrap();

    // Canonical agent in user scope and project scope
    let canon_agent = r#"---
version: 1
name: reviewer
description: Reviews code carefully.
targets:
  claude:
    model: opus
    tools: Read, Grep, Glob
  codex:
    sandbox_mode: read-only
  agy:
    mainAgent: false
    subagent: true
    tools:
      - read_file
      - search_web
---

Inspect changes for bugs.
"#;
    fs::write(
        home.join(".agents/overlord/agents/reviewer.md"),
        canon_agent,
    )
    .unwrap();
    fs::write(
        repo.join(".agents/overlord/agents/reviewer.md"),
        canon_agent,
    )
    .unwrap();

    assert!(run_overlord(home, &["sync"]).status.success());

    // User outputs exist for Claude, Codex, and agy
    assert!(home.join(".claude/agents/reviewer.md").is_file());
    assert!(home.join(".codex/agents/reviewer.toml").is_file());
    assert!(home.join(".gemini/config/agents/reviewer.md").is_file());

    // Project outputs exist for Claude, Codex, and agy (.agents/agents/reviewer.md)
    assert!(repo.join(".claude/agents/reviewer.md").is_file());
    assert!(repo.join(".codex/agents/reviewer.toml").is_file());
    assert!(repo.join(".agents/agents/reviewer.md").is_file());

    // Edit rendered agy output -> auto-captured back into canonical and propagated to Claude & Codex!
    let agy_edited = r#"---
name: reviewer
description: Reviews code carefully v2.
mainAgent: true
subagent: true
tools:
  - read_file
---

Inspect changes for bugs and security issues.
"#;
    fs::write(home.join(".gemini/config/agents/reviewer.md"), agy_edited).unwrap();
    assert!(run_overlord(home, &["sync"]).status.success());

    let updated_canon =
        fs::read_to_string(home.join(".agents/overlord/agents/reviewer.md")).unwrap();
    assert!(updated_canon.contains("Reviews code carefully v2."));
    assert!(updated_canon.contains("mainAgent: true"));
    let updated_codex = fs::read_to_string(home.join(".codex/agents/reviewer.toml")).unwrap();
    assert!(updated_codex.contains("security issues"));

    // Concurrent incompatible edit to canonical + Claude output -> conflict!
    fs::write(
        home.join(".agents/overlord/agents/reviewer.md"),
        updated_canon.replace("security issues", "canonical edit"),
    )
    .unwrap();
    let claude_text = fs::read_to_string(home.join(".claude/agents/reviewer.md")).unwrap();
    fs::write(
        home.join(".claude/agents/reviewer.md"),
        claude_text.replace("security issues", "claude edit"),
    )
    .unwrap();

    let conflict_sync = run_overlord(home, &["sync", "--json"]);
    assert!(!conflict_sync.status.success());
    let doc: serde_json::Value = serde_json::from_slice(&conflict_sync.stdout).unwrap();
    assert_eq!(doc["ok"], false);
    assert!(!doc["diagnostics"].as_array().unwrap().is_empty());
}

#[test]
fn instructions_links_and_delegating_at_agents_md() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();
    assert!(run_overlord(home, &["init"]).status.success());

    let projects = home.join("Projects");
    fs::create_dir_all(&projects).unwrap();
    fs::write(
        home.join(".agents/overlord/overlord.yaml"),
        "roots:\n  - ~/Projects\n",
    )
    .unwrap();

    // User AGENTS.md + an unrelated dirty file in ~/.agents that must NOT be committed
    fs::write(home.join(".agents/AGENTS.md"), "# Global Rules\n").unwrap();
    fs::write(home.join(".agents/unmanaged.txt"), "leave me untracked\n").unwrap();

    // Project 1: direct child with only AGENTS.md (like opencarve)
    let p1 = projects.join("new-rust-app");
    fs::create_dir_all(&p1).unwrap();
    fs::write(p1.join("AGENTS.md"), "# App Rules\n").unwrap();

    // Project 2: direct child with standalone CLAUDE.md only -> adopted to AGENTS.md + symlink
    let p2 = projects.join("claude-init-app");
    fs::create_dir_all(&p2).unwrap();
    fs::write(p2.join("CLAUDE.md"), "# Adopted from Claude\n").unwrap();

    // Project 3: cloned upstream repo with @AGENTS.md in CLAUDE.md (like open-xy) -> left untouched
    let p3 = projects.join("upstream-repo");
    write_skill(&p3.join(".agents/skills/up-skill"), "up-skill", "Upstream");
    fs::write(p3.join("AGENTS.md"), "# Upstream Agents\n").unwrap();
    fs::write(p3.join("CLAUDE.md"), "@AGENTS.md\n").unwrap();

    assert!(run_overlord(home, &["sync"]).status.success());
    assert!(run_overlord(home, &["check"]).status.success());

    // User links
    assert_eq!(
        fs::read_link(home.join(".claude/CLAUDE.md")).unwrap(),
        PathBuf::from("../.agents/AGENTS.md")
    );
    assert_eq!(
        fs::read_link(home.join(".codex/AGENTS.md")).unwrap(),
        PathBuf::from("../.agents/AGENTS.md")
    );
    assert_eq!(
        fs::read_link(home.join(".gemini/AGENTS.md")).unwrap(),
        PathBuf::from("../.agents/AGENTS.md")
    );

    // Unmanaged file in ~/.agents stayed untracked
    let git_status = Command::new("git")
        .current_dir(home.join(".agents"))
        .args(["status", "--porcelain"])
        .output()
        .unwrap();
    let status_str = String::from_utf8_lossy(&git_status.stdout);
    assert!(
        status_str.contains("?? unmanaged.txt"),
        "status: {status_str}"
    );

    // Project 1 got relative CLAUDE.md -> AGENTS.md
    assert_eq!(
        fs::read_link(p1.join("CLAUDE.md")).unwrap(),
        PathBuf::from("AGENTS.md")
    );

    // Project 2 adopted CLAUDE.md -> AGENTS.md
    assert_eq!(
        fs::read_to_string(p2.join("AGENTS.md")).unwrap(),
        "# Adopted from Claude\n"
    );
    assert_eq!(
        fs::read_link(p2.join("CLAUDE.md")).unwrap(),
        PathBuf::from("AGENTS.md")
    );

    // Project 3 kept its regular @AGENTS.md file untouched
    assert!(
        !fs::symlink_metadata(p3.join("CLAUDE.md"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_to_string(p3.join("CLAUDE.md")).unwrap(),
        "@AGENTS.md\n"
    );

    // Deleting ~/.agents/AGENTS.md prunes stale user links and commits the deletion in ~/.agents
    fs::remove_file(home.join(".agents/AGENTS.md")).unwrap();
    let del_sync = run_overlord(home, &["sync", "--json"]);
    assert!(
        del_sync.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&del_sync.stderr)
    );
    let del_doc: serde_json::Value = serde_json::from_slice(&del_sync.stdout).unwrap();
    assert!(del_doc["gitCommit"].is_string());
    assert!(fs::symlink_metadata(home.join(".claude/CLAUDE.md")).is_err());
    assert!(fs::symlink_metadata(home.join(".codex/AGENTS.md")).is_err());
    assert!(fs::symlink_metadata(home.join(".gemini/AGENTS.md")).is_err());

    // Service dry-run renders plist/systemd unit cleanly without writing files
    let svc_dry = run_overlord(home, &["service", "install", "--dry-run"]);
    assert!(svc_dry.status.success());
}

#[test]
fn watch_propagates_changes_and_stops_cleanly_on_sigterm() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();
    assert!(run_overlord(home, &["init"]).status.success());

    let child = Command::new(bin())
        .arg("watch")
        .env("HOME", home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn watch");

    thread::sleep(Duration::from_millis(400));

    // Create a new canonical skill while watch is running
    write_skill(
        &home.join(".agents/skills/live-skill"),
        "live-skill",
        "Live",
    );

    // Wait up to 4s for symlink propagation
    let mut linked = false;
    for _ in 0..20 {
        if fs::symlink_metadata(home.join(".gemini/config/skills/live-skill")).is_ok()
            && fs::symlink_metadata(home.join(".claude/skills/live-skill")).is_ok()
        {
            linked = true;
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    assert!(linked, "watch did not propagate live-skill links in time");

    // Send SIGTERM and verify clean 0 exit
    let _ = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status();
    let out = child.wait_with_output().expect("wait watch");
    assert!(out.status.success(), "watch exit: {:?}", out.status);
}

#[test]
fn native_agent_delete_propagation_state_pruning_and_nested_git_instructions() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();
    assert!(run_overlord(home, &["init"]).status.success());

    let projects = home.join("Projects");
    fs::create_dir_all(&projects).unwrap();
    fs::write(
        home.join(".agents/overlord/overlord.yaml"),
        "roots:\n  - ~/Projects\n",
    )
    .unwrap();

    // Project A: single custom agent -> verify native deletion propagates and prunes empty .codex/.claude dirs
    let proj_a = projects.join("proj-a");
    fs::create_dir_all(proj_a.join(".agents/overlord/agents")).unwrap();
    let agent_src = r#"---
version: 1
name: temp-agent
description: Temporary agent.
targets:
  claude:
    model: haiku
  codex:
    sandbox_mode: read-only
  agy:
    mainAgent: true
    subagent: true
    tools:
      - read_file
---

Temp instructions.
"#;
    fs::write(
        proj_a.join(".agents/overlord/agents/temp-agent.md"),
        agent_src,
    )
    .unwrap();

    // Project B: will be deleted wholesale -> verify state.json prunes its scope entry
    let proj_b = projects.join("proj-b");
    fs::create_dir_all(proj_b.join(".agents/overlord/agents")).unwrap();
    fs::write(
        proj_b.join(".agents/overlord/agents/temp-agent.md"),
        agent_src,
    )
    .unwrap();

    // Project C: depth-2 nested git repo with only AGENTS.md
    let proj_c = projects.join("group/nested-git");
    fs::create_dir_all(proj_c.join(".git")).unwrap();
    fs::write(proj_c.join("AGENTS.md"), "# Nested Git Rules\n").unwrap();

    assert!(run_overlord(home, &["sync"]).status.success());
    assert!(proj_a.join(".claude/agents/temp-agent.md").is_file());
    assert!(proj_a.join(".codex/agents/temp-agent.toml").is_file());
    assert!(proj_a.join(".agents/agents/temp-agent.md").is_file());
    assert_eq!(
        fs::read_link(proj_c.join("CLAUDE.md")).unwrap(),
        PathBuf::from("AGENTS.md")
    );

    // Delete rendered Claude output natively in proj_a -> propagates to canonical, codex, agy, and prunes .codex/.claude!
    fs::remove_file(proj_a.join(".claude/agents/temp-agent.md")).unwrap();
    assert!(run_overlord(home, &["sync"]).status.success());
    assert!(
        !proj_a
            .join(".agents/overlord/agents/temp-agent.md")
            .exists()
    );
    assert!(!proj_a.join(".codex/agents/temp-agent.toml").exists());
    assert!(!proj_a.join(".agents/agents/temp-agent.md").exists());
    assert!(!proj_a.join(".codex").exists());
    assert!(!proj_a.join(".claude").exists());

    // Delete entire proj_b directory -> state.json prunes proj_b!
    fs::remove_dir_all(&proj_b).unwrap();
    assert!(run_overlord(home, &["sync"]).status.success());
    let state_raw = fs::read_to_string(home.join(".local/state/overlord/state.json")).unwrap();
    let state_doc: serde_json::Value = serde_json::from_str(&state_raw).unwrap();
    let keys: Vec<&str> = state_doc["agents"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert!(
        keys.is_empty(),
        "expected empty state.agents after removing temp agents & proj_b, got {keys:?}"
    );

    // Re-add agent to proj_a, then delete rendered output WHILE modifying canonical -> conflict!
    fs::create_dir_all(proj_a.join(".agents/overlord/agents")).unwrap();
    fs::write(
        proj_a.join(".agents/overlord/agents/temp-agent.md"),
        agent_src,
    )
    .unwrap();
    assert!(run_overlord(home, &["sync"]).status.success());

    fs::remove_file(proj_a.join(".claude/agents/temp-agent.md")).unwrap();
    fs::write(
        proj_a.join(".agents/overlord/agents/temp-agent.md"),
        agent_src.replace("Temp instructions.", "Modified canonical instructions."),
    )
    .unwrap();
    let conflict = run_overlord(home, &["sync", "--json"]);
    assert!(!conflict.status.success());
    assert!(
        proj_a
            .join(".agents/overlord/agents/temp-agent.md")
            .exists()
    );
    assert!(proj_a.join(".codex/agents/temp-agent.toml").exists());
}
