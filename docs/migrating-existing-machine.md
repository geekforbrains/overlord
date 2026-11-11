# Migrating an Existing Machine

Use this guide when migrating a machine from standalone Claude Code / Codex / Antigravity (`agy`) configurations or from Overlord `v0.2.x`–`v0.3.x` (Node/TypeScript) to Overlord `v0.4.0+` (Rust).

## Migrating from Overlord v0.3.x (TypeScript/Node)

1. **Stop and uninstall the legacy Node LaunchAgent / systemd unit** (before removing the old checkout):
   ```sh
   overlord service uninstall
   ```
   If you had `npm link`ed the old Node CLI globally, remove the old global npm link (`npm rm -g @geekforbrains/overlord` or remove the old symlink from your global npm bin directory).

2. **Install the Rust `overlord` binary:**
   ```sh
   curl -fsSL https://raw.githubusercontent.com/geekforbrains/overlord/main/install.sh | sh
   overlord --version
   ```

3. **Remove the legacy ledger directory (optional cleanup):**
   Overlord `v0.4.0+` stores machine-local state in `~/.local/state/overlord/state.json` instead of `~/.agents/.git/overlord/`.
   ```sh
   rm -rf ~/.agents/.git/overlord
   ```

4. **Add `targets.agy` overlays to canonical custom agents (if using `agy`):**
   Review `~/.agents/overlord/agents/*.md` and any `<project>/.agents/overlord/agents/*.md`. Because `agy` requires `tools` to be a YAML list of `agy` tool names (`read_file`, `edit_file`, `write_file`, `run_command`, `manage_task`, `search_web`), add an explicit `agy` target block (or `agy: false` to skip rendering for `agy`):
   ```yaml
   targets:
     claude:
       model: opus
       tools: Read, Grep, Glob, Bash
     codex: {}
     agy:
       mainAgent: false
       subagent: true
       tools:
         - read_file
         - run_command
   ```

5. **Preview and run `overlord sync`:**
   ```sh
   overlord sync --dry-run
   overlord sync
   overlord check
   ```
   During this sync, Overlord automatically:
   - Replaces identical copied `.claude/skills/<name>/` directories with per-skill symlinks to `.agents/skills/<name>/`.
   - Symlinks user skills into `~/.gemini/config/skills/<name>`.
   - Renders custom agents across Claude, Codex, and `agy`.
   - Ensures `AGENTS.md` / `CLAUDE.md` symlinks are in place across user and discovered project scopes.
   - Updates `~/.agents/skills/overlord/SKILL.md` if you run `overlord init` or update it directly, and commits managed user-scope changes in `~/.agents`.

6. **Reinstall the background service:**
   ```sh
   overlord service install
   overlord service status
   ```

## Migrating a machine that never used Overlord

1. **Back up existing dot-directories** outside your configured project roots:
   ```sh
   mkdir -p ~/overlord-backup
   cp -R ~/.agents ~/.claude ~/.codex ~/.gemini ~/overlord-backup/ 2>/dev/null || true
   ```
2. **Initialize Overlord and configure `roots`:**
   ```sh
   overlord init
   nvim ~/.agents/overlord/overlord.yaml
   ```
3. **Preview planned adoptions and links:**
   ```sh
   overlord sync --dry-run
   ```
   - Standalone physical skills in `.claude/skills/<name>/` or `~/.gemini/config/skills/<name>/` are adopted into `.agents/skills/<name>/` and replaced with symlinks.
   - Standalone native custom agents are adopted into `.agents/overlord/agents/<name>.md` when unambiguous; if two CLIs already define different agents under the same name, Overlord reports a conflict without overwriting either file so you can merge them manually.
   - Standalone `CLAUDE.md` files in scopes without `AGENTS.md` are adopted into `AGENTS.md` and replaced with a relative symlink.
4. **Apply and verify:**
   ```sh
   overlord sync
   overlord check
   ```
