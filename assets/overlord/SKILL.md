---
name: overlord
description: Manage local skills, custom agents, AGENTS.md links, and background auto-sync across Claude Code, OpenAI Codex, and Google Antigravity (agy) with Overlord.
---

# Overlord

Use `overlord` to synchronize persistent skills, custom agents, and `AGENTS.md` links across Claude Code (`claude`), OpenAI Codex (`codex`), and Google Antigravity (`agy`). Commands inspect the user scope (`~/.agents`) and every project discovered under `roots` in `~/.agents/overlord/overlord.yaml`, regardless of the current working directory.

## Workflow

1. Run `overlord status --json` (or `overlord sync --dry-run`) to inspect scopes, planned actions, and diagnostics.
2. Author or edit canonical definitions in the target scope:
   - **Skills:** `<scope>/.agents/skills/<name>/SKILL.md` (physical files only; Overlord creates per-skill symlinks for Claude and user-level `agy`, while Codex and project-level `agy` read `.agents/skills` directly).
   - **Custom agents:** `<scope>/.agents/overlord/agents/<name>.md` (`version: 1`, `name`, `description`, and `targets: { claude, codex, agy }`). Overlord renders native files to `.claude/agents/<name>.md`, `.codex/agents/<name>.toml`, and `~/.gemini/config/agents/<name>.md` or `<repo>/.agents/agents/<name>.md`.
   - **Instructions:** `~/.agents/AGENTS.md` (user) or `<repo>/AGENTS.md` (project). Overlord maintains `CLAUDE.md` and user-level `.codex/AGENTS.md` / `.gemini/AGENTS.md` symlinks.
3. Run `overlord sync` to apply changes, capture unambiguous edits made to rendered agent files or newly created provider skills, and auto-commit managed user-scope changes in `~/.agents`.
4. Run `overlord check` (exits `0` only when the fleet has zero conflicts, errors, or pending actions).

## Guardrails

- Report conflicts or invalid definitions with their exact scope and paths; never guess a conflict winner or overwrite diverging files without explicit user approval.
- Never place symlinks inside canonical `.agents/skills/` or `.agents/overlord/agents/`; Overlord owns the outbound symlinks in provider directories.
- Overlord commits managed changes only in `~/.agents` and never pushes or commits project repositories.
- Use `overlord watch` for foreground auto-sync, or `overlord service install [--dry-run]`, `overlord service status`, `overlord service logs`, and `overlord service uninstall` for the per-user background service (`launchd` on macOS, `systemd --user` on Linux). Re-run `overlord service install` after moving or upgrading the `overlord` binary.
