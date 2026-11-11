# macOS Quick Start

Set up Overlord on macOS to keep Claude Code (`claude`), OpenAI Codex (`codex`), and Google Antigravity CLI (`agy`) skills, custom agents, and `AGENTS.md` / `CLAUDE.md` instructions synchronized automatically.

## 1. Install the binary

Install the latest macOS release directly into `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/geekforbrains/overlord/main/install.sh | sh
```

Ensure `~/.local/bin` is on your `PATH`, then verify:

```sh
overlord --version
```

## 2. Initialize `~/.agents`

```sh
overlord init
```

This creates `~/.agents` (if missing), initializes its dedicated Git repository, writes `~/.agents/overlord/overlord.yaml`, installs the bundled `overlord` skill under `~/.agents/skills/overlord/SKILL.md`, and commits the initial managed state.

## 3. Configure discovery roots

Edit `~/.agents/overlord/overlord.yaml` to list the parent folders where your projects live:

```yaml
roots:
  - ~/Projects
```

## 4. Preview and run the first sync

Always preview before applying on an existing setup:

```sh
overlord sync --dry-run
overlord sync
overlord check
```

`overlord check` exits `0` when all canonical definitions, per-skill symlinks, rendered custom agents, and `AGENTS.md` / `CLAUDE.md` symlinks agree across `claude`, `codex`, and `agy`.

## 5. Install the background LaunchAgent

Preview the exact `launchd` plist first, then install and start it:

```sh
overlord service install --dry-run
overlord service install
overlord service status
```

The LaunchAgent (`io.github.geekforbrains.overlord.watch`) starts automatically on login, watches managed directories with a 500ms debounce, and performs a read-only fleet rescan every 5 seconds.

## 6. Inspect logs or uninstall

```sh
overlord service logs
overlord service uninstall
```

Uninstalling stops and removes only the LaunchAgent plist and receipt while leaving `~/.agents`, project files, symlinks, and rendered agents untouched.
