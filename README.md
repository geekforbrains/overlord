# Overlord

Overlord is a single standalone Rust binary that keeps skills, custom agents, and `AGENTS.md` / `CLAUDE.md` instructions synchronized across **Claude Code (`claude`)**, **OpenAI Codex (`codex`)**, and **Google Antigravity CLI (`agy`)** at both user (`~`) and project scopes.

Every scope keeps a single canonical `.agents/` directory. Skills and `AGENTS.md` instructions are linked via per-item symlinks so only one real folder or file exists on disk, while custom agents are rendered into each CLI's native format and 3-way reconciled when edited natively.

## Install

Install the prebuilt macOS or Linux binary directly from GitHub Releases into `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/geekforbrains/overlord/main/install.sh | sh
```

Pin a specific release or custom install directory with environment variables:

```sh
OVERLORD_VERSION=v0.4.0 OVERLORD_INSTALL_DIR="$HOME/.local/bin" \
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/geekforbrains/overlord/main/install.sh)"
```

Or build from source with Rust 1.91+:

```sh
git clone https://github.com/geekforbrains/overlord.git
cd overlord
cargo install --path . --locked
```

> **Note:** Overlord is not published to npm or crates.io. Do not install unrelated packages named `overlord` from third-party registries. The previous TypeScript/Node implementation is archived on the `typescript` branch.

## Quick start

```sh
overlord init
nvim ~/.agents/overlord/overlord.yaml   # add project discovery roots
overlord sync --dry-run                 # preview planned links and renders
overlord sync                           # apply changes
overlord check                          # verify fleet is clean (exits 0)
overlord service install                # start background auto-sync on login
```

Example `~/.agents/overlord/overlord.yaml`:

```yaml
roots:
  - ~/Projects
```

See the [macOS quick start](docs/macos-quickstart.md), [Migrating an existing machine](docs/migrating-existing-machine.md), and [Background auto-sync service](docs/background-service.md) for detailed guides.

## Path mapping across CLIs

| Artifact | Canonical Source | Claude Code (`claude`) | OpenAI Codex (`codex`) | Antigravity (`agy`) |
| :--- | :--- | :--- | :--- | :--- |
| **User skills** | `~/.agents/skills/<name>/` | `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/<name>` (symlink) | Reads `~/.agents/skills/<name>/` natively | `${GEMINI_DIR:-~/.gemini}/config/skills/<name>` (symlink) |
| **Project skills** | `<project>/.agents/skills/<name>/` | `<project>/.claude/skills/<name>` (`-> ../../.agents/skills/<name>`) | Reads `<project>/.agents/skills/<name>/` natively | Reads `<project>/.agents/skills/<name>/` natively |
| **User agents** | `~/.agents/overlord/agents/<name>.md` | `${CLAUDE_CONFIG_DIR:-~/.claude}/agents/<name>.md` (rendered) | `${CODEX_HOME:-~/.codex}/agents/<name>.toml` (rendered) | `${GEMINI_DIR:-~/.gemini}/config/agents/<name>.md` (rendered) |
| **Project agents** | `<project>/.agents/overlord/agents/<name>.md` | `<project>/.claude/agents/<name>.md` (rendered) | `<project>/.codex/agents/<name>.toml` (rendered) | `<project>/.agents/agents/<name>.md` (rendered) |
| **User `AGENTS.md`** | `~/.agents/AGENTS.md` | `${CLAUDE_CONFIG_DIR:-~/.claude}/CLAUDE.md` (symlink) | `${CODEX_HOME:-~/.codex}/AGENTS.md` (symlink) | `${GEMINI_DIR:-~/.gemini}/AGENTS.md` (symlink) |
| **Project `AGENTS.md`** | `<project>/AGENTS.md` | `<project>/CLAUDE.md` (`-> AGENTS.md`) | Reads `<project>/AGENTS.md` natively | Reads `<project>/AGENTS.md` natively |

> **Workspace trust note:** Both `codex` and `agy` only load project-scoped skills and custom agents after the exact workspace path is trusted inside each CLI (`agy` stores trusted workspaces in `~/.gemini/antigravity-cli/settings.json`). Overlord never mutates provider trust files.

## How each artifact works

### 1. Per-skill symlinks

Canonical skills live in `.agents/skills/<name>/SKILL.md` (with optional `scripts/`, `references/`, `assets/`).

- Overlord creates per-skill symlinks rather than whole-folder symlinks so Claude's internal `.claude/skills/.trash/` and `.claude/skills/synced/` directories remain untouched under Claude's control, and `agy`'s workspace symlink-containment boundary is respected (`agy` reads `<project>/.agents/skills/` directly inside the repo).
- If you or a CLI create a new physical skill folder in `.claude/skills/<name>/` or `~/.gemini/config/skills/<name>/`, Overlord adopts it into `.agents/skills/<name>/` and replaces the physical folder with a symlink.
- Legacy copied skill folders whose contents match `.agents/skills/<name>/` are converted into symlinks automatically on `overlord sync`.
- Deleting `.agents/skills/<name>/` prunes Overlord's symlinks while leaving foreign third-party symlinks untouched.

### 2. Portable custom agents (`targets: { claude, codex, agy }`)

Because Claude Code, Codex, and `agy` require incompatible agent schemas (Claude Markdown, Codex TOML, and `agy` Markdown with strict YAML sequence `tools` and `agy`-specific model/tool names), Overlord keeps one canonical Markdown definition in `.agents/overlord/agents/<name>.md`:

```markdown
---
version: 1
name: code-review-agent
description: Reviews changes for correctness, regressions, and missing tests.
targets:
  claude:
    model: opus
    tools: Read, Grep, Glob, Bash
  codex:
    sandbox_mode: read-only
  agy:
    mainAgent: true
    subagent: true
    tools:
      - read_file
      - run_command
      - manage_task
---

Review the requested change. Lead with actionable findings and cite files.
```

- Set any target (`claude`, `codex`, or `agy`) to `false` to omit rendering for that CLI (`agy` outputs are deleted if previously rendered).
- `agy` silently ignores `.md` agent files if `tools` is a comma-separated string or `model` is a Claude model name (`opus`, `sonnet`, `haiku`). Overlord validates `targets.agy` up front (`tools` must be a YAML list such as `[read_file, edit_file, write_file, run_command, manage_task, search_web]`) so invalid definitions surface immediately during `overlord check` / `overlord sync`.
- Overlord tracks SHA-256 digests in `~/.local/state/overlord/state.json` to perform 3-way reconciliation: unambiguous edits to a rendered output are captured back into `.agents/overlord/agents/<name>.md` and propagated to the other CLIs, while concurrent incompatible edits are flagged as conflicts without overwriting either side.

### 3. `AGENTS.md` and `CLAUDE.md` links

- **User scope:** When `~/.agents/AGENTS.md` exists, Overlord links `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `~/.gemini/AGENTS.md` to `../.agents/AGENTS.md`.
- **Project scopes:** For discovered projects (and direct children of configured `roots` that carry `AGENTS.md` or `CLAUDE.md`), Overlord links `<project>/CLAUDE.md -> AGENTS.md`.
- If a scope only has a regular `CLAUDE.md` file and no `AGENTS.md`, Overlord adopts it into `AGENTS.md` and replaces `CLAUDE.md` with a relative symlink.
- Upstream repositories whose `CLAUDE.md` delegates via `@AGENTS.md` (or `@./AGENTS.md`) are recognized and left untouched so upstream working trees stay clean.

### 4. Git boundary

- `~/.agents` is the **only** Git repository Overlord initializes or commits to. During `overlord init` and `overlord sync`, Overlord stages and commits changes under `skills/`, `overlord/`, and `AGENTS.md` without disturbing unrelated files in `~/.agents`, and never pushes to a remote.
- Overlord **never** initializes, stages, commits, or pushes any discovered project repository.

## Commands

| Command | Behavior |
| :--- | :--- |
| `overlord init [--json]` | Initialize `~/.agents` Git repo, `overlord.yaml`, and bundled `overlord` skill. |
| `overlord status [--json]` | Read-only inspection across user and project scopes (always exits `0`). |
| `overlord check [--json]` | Read-only inspection; exits `1` if any pending actions, warnings, or errors exist. |
| `overlord sync [--dry-run] [--json]` | Reconcile skills, agents, and `AGENTS.md` links across all scopes. |
| `overlord watch` | Run an initial sync, then watch managed roots and rescan every 5s until `SIGINT`/`SIGTERM`. |
| `overlord service install [--dry-run]` | Preview or install and start the per-user LaunchAgent (macOS) or systemd user unit (Linux). |
| `overlord service status` | Check ownership receipt, pinned binary, and service manager state. |
| `overlord service logs` | Print recent service logs. |
| `overlord service uninstall` | Stop and remove the Overlord-owned service definition and receipt while keeping all files intact. |

## Development

```sh
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
cargo build --release --locked
```

## Documentation

- [macOS quick start](docs/macos-quickstart.md)
- [Background auto-sync service](docs/background-service.md)
- [Migrating an existing machine](docs/migrating-existing-machine.md)
- [Changelog](CHANGELOG.md)
