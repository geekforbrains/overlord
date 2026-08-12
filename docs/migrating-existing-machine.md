# Migrating an existing machine

Use this runbook when `~/.agents`, Claude, or Codex already contains skills or custom agents. It is intentionally more cautious than a clean installation: existing canonical and provider-native definitions can disagree before Overlord has a reconciliation baseline.

Overlord does not migrate legacy configuration, create migration backups, or choose a winner for a conflict. Keep every backup outside `.agents`, `.claude`, `.codex`, and every configured discovery root so the backup cannot be inventoried as another definition.

The examples use the linked `overlord` command. When running from source, replace it with `node /absolute/path/to/overlord/dist/cli.js`.

## 1. Inventory before changing anything

Record the current state before running `init` or editing a definition:

- The contents of `~/.agents/overlord/overlord.yaml`, if present.
- The effective `CLAUDE_CONFIG_DIR` and `CODEX_HOME` values.
- User definitions below `~/.agents/skills`, `~/.agents/overlord/agents`, the effective Claude `skills` and `agents` directories, and the effective Codex `agents` directory.
- Project definitions below `.agents/skills`, `.agents/overlord/agents`, `.claude/skills`, `.claude/agents`, and `.codex/agents` in every project that may become discoverable.
- Git status for `~/.agents`, each affected project, and any dotfiles repository containing a user-native Claude or Codex directory.
- Symlinks, unexpected files, and generated cache or metadata files anywhere inside those managed paths.

Check whether `~/.agents/.git` is already a physical, dedicated repository. When it is, `overlord status --json` is the correct first dry run. When `~/.agents` exists without that repository, `status`, `check`, `sync`, and `watch` fail without initializing it; continue with the configuration and backup steps below, then use `overlord init` to bootstrap it.

## 2. Make a migration backup

Choose a new backup directory outside all configured discovery roots. Copy every existing managed canonical and native path into it while preserving relative paths and executable bits. Include the legacy configuration and the output of Git status for every repository involved.

For example, after replacing the placeholder with a fresh location:

```sh
BACKUP_ROOT=/absolute/path/outside/managed/roots/overlord-before-migration
mkdir -p "$BACKUP_ROOT"

# Run only for paths that exist, and use distinct destination names.
cp -a ~/.agents "$BACKUP_ROOT/user-agents"
cp -a "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills" "$BACKUP_ROOT/user-claude-skills"
cp -a "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents" "$BACKUP_ROOT/user-claude-agents"
cp -a "${CODEX_HOME:-$HOME/.codex}/agents" "$BACKUP_ROOT/user-codex-agents"
```

Back up each affected project's `.agents`, `.claude`, and `.codex` managed paths separately. Do not place a backup beside a live skill or agent: a backup inside a managed root can be discovered, copied, or reported as a duplicate.

`init` and `sync` do not replace this backup. File publication is designed to avoid partial file writes, but Overlord does not retain displaced definitions in a persistent backup directory.

## 3. Replace legacy configuration

The current configuration contains exactly one key, `roots`, and has no version field:

```yaml
# ~/.agents/overlord/overlord.yaml
roots:
  - ~/Projects
  - /Volumes/work/clients
```

Each entry must be an absolute path or start with `~/`. A root is both a project candidate and a recursive discovery boundary.

Legacy version 1 configuration used `external` entries:

```yaml
version: 1
external:
  - kind: skill
    name: example
    target: claude
```

There is no one-to-one conversion for `external`. Preserve the old file in the migration backup, list every external entry, and decide explicitly whether its definition should now be managed. A supported definition inside a configured root is part of the fleet; keeping it unmanaged requires leaving it outside the configured fleet or outside Overlord's managed artifact paths.

Derive `roots` from the parent directories that contain the projects you intend Overlord to discover. Do not translate a skill or agent name into a root. If an intermediate configuration already has `version: 2` and `roots`, remove the `version` key and retain the reviewed roots.

Overlord rejects legacy and unknown configuration keys. It does not rewrite them automatically, and `init` validates the configuration before creating the user Git repository or bundled skill.

## 4. Audit definitions before initialization

Correct structural problems that you can identify without choosing between competing definitions. Keep the original bytes in the migration backup.

### Skills

- A skill must be a physical directory containing `SKILL.md` with valid YAML frontmatter.
- Its `name` must match the directory name and use 1–64 lowercase ASCII letters, digits, or single hyphens, without leading, trailing, or consecutive hyphens.
- `description` must be a non-empty string no longer than 1,024 characters.
- Symlinks and nested `.git` entries, including case variants, are invalid anywhere in a skill tree.

Older skills commonly omit `name`; add it only after confirming the directory name is the intended portable name. Quote YAML descriptions that contain syntax-significant text such as `: ` so their existing prose remains one string.

Codex skills below `.codex/skills` are not inventoried by current Overlord. Back them up and make an explicit migration decision; the managed Codex-readable location is the scope's `.agents/skills` directory.

### Portable agents

A canonical agent under `.agents/overlord/agents/<name>.md` needs valid YAML frontmatter and a non-empty instruction body:

```markdown
---
version: 1
name: reviewer
description: Reviews changes before they are committed.
targets:
  claude: {}
  codex: {}
---

Review the requested change and report concrete findings.
```

The `name` must match the file stem and use lowercase ASCII letters or single hyphens. The only target keys are `claude` and `codex`; set a target to `false` to disable it. Provider-only fields belong under the corresponding target mapping.

Do not silently rewrite invalid portable frontmatter to make an error disappear. Record the diagnostic and obtain an explicit content decision. Invalid canonical content can block otherwise safe mutation in that scope.

Overlord can render a valid project agent without activating it inside an already-running provider session. Current Codex releases load project `.codex/agents/*.toml` only when that exact project or repository is trusted; a trusted ancestor such as `~/Projects` does not confer trust on its descendants. Establish trust through Codex, then start a fresh Codex session before testing the agent. Overlord does not create `.codex/config.toml` or grant provider trust, and a synchronized file alone is not proof that the provider loaded it. See the [Codex custom-agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents).

### Symlinks and cache files

Managed artifact roots, definition directories, definition files, and skill payload entries must be physical filesystem objects. Replace a symlink only after recording its target and deciding which physical content should be retained.

Known operating-system metadata such as `.DS_Store`, `Desktop.ini`, `Thumbs.db`, `ehthumbs.db`, and `._*` names may be ignored. Do not assume arbitrary caches are ignored: move disposable caches out of managed agent roots after backing them up, and remember that non-ignored files inside a skill are part of that skill's synchronized payload.

For example, `__pycache__` directories and `.pyc` files inside a skill are ordinary payload, not automatic exclusions. If they should not be committed and copied to providers, move them out before `init` or `sync` and prevent the generating tool from recreating them there. A Git ignore rule alone does not exclude a physical file from Overlord's skill payload.

## 5. Initialize the existing user source

Once the current configuration is valid and the backup is complete, run:

```sh
overlord init
```

When `~/.agents` already exists without Git, `init` initializes the dedicated repository in place. It creates missing managed directories and files, installs the bundled Overlord skill only when absent, initializes private ledger storage, and makes an `overlord: initialize` commit containing the managed user source. It does not overwrite a different installed Overlord skill.

Review the reported commit and verify the repository immediately:

```sh
git -C ~/.agents status --short
git -C ~/.agents show --stat --oneline HEAD
```

`init` is not a definition migration or conflict-resolution pass. Existing provider-native files and project definitions have not yet been synchronized.

## 6. Use status as the dry run

Capture the complete read-only inventory:

```sh
overlord status --json > "$BACKUP_ROOT/status-before-sync.json"
```

Inspect every scope, definition, planned action, and diagnostic. `status` exits successfully even when it reports `attention-required`, so its exit code alone is not approval to synchronize.

With no ledger baseline yet, expect these outcomes:

| Observed state in one scope | Expected result |
| --- | --- |
| One valid canonical definition only | Planned provider materialization. |
| One valid provider-native definition only | Planned import into that same scope's `.agents`, then propagation to other enabled endpoints. |
| Matching valid canonical and native definitions | Safe initial convergence when the representations normalize to the same content. |
| Different canonical and native definitions, or incompatible native definitions | Baseline-free conflict; no winner is selected. |
| Invalid canonical or native definition | Diagnostic and preserved content; safe work may be blocked according to the affected scope and endpoint. |

A provider-only project can therefore be discovered and imported without being hoisted into the user scope, provided its definition is valid and its project is below a configured root.

## 7. Resolve every conflict explicitly

Overlord never auto-resolves a conflict. For each conflict, identify the exact `scopePath`, definition, canonical path, native paths, and evidence from `status --json`. Then obtain an explicit choice:

- Keep the canonical definition and make or remove the competing native copies after backing them up.
- Keep one provider definition and convert its intended common content into a valid portable canonical definition, preserving provider-only settings in target overlays.
- Manually merge the competing definitions into a new canonical definition, then align or remove the superseded native copies.
- Leave the conflict unresolved and accept that Overlord will preserve it and continue only with unrelated safe work.

Do not let an LLM infer the winner from modification time, apparent quality, or provider preference. Before editing or removing a conflicting path, copy that exact path to the migration backup. Keep those copies outside managed and discovery roots.

Run `overlord status --json` again after each group of decisions. Continue only when its proposed actions match the user's intent.

## 8. Synchronize and verify

Apply the reviewed safe plan:

```sh
overlord sync --json > "$BACKUP_ROOT/sync.json"
overlord check --json > "$BACKUP_ROOT/check.json"
```

`sync` can complete safe work in healthy scopes while leaving conflicts or invalid definitions untouched, and therefore may exit with attention still required. `check` exits non-zero while any scope needs attention. Read both JSON documents rather than relying only on terminal exit codes.

For the user scope, Overlord commits selected managed canonical changes in `~/.agents` before propagating user provider outputs. It never commits a project repository or a repository that happens to contain `.claude` or `.codex` user-native files.

Inspect the resulting Git changes yourself:

```sh
git -C ~/.agents status --short
git -C /absolute/path/to/project status --short -- .agents .claude .codex
git -C /absolute/path/to/project diff -- .agents .claude .codex
```

Repeat the project checks for every affected repository, and inspect any dotfiles repository that owns a user-native Claude or Codex path. Decide separately whether to commit, ignore, or revert those changes; Overlord does not make that source-control decision.

Do not discard the migration backup until `check` is clean, provider behavior has been verified, and the resulting Git changes have been reviewed.

## 9. Start auto-sync last

Start either form of auto-sync only after the one-shot migration is understood and `check` is clean. A managed-service installation refuses an attention-required baseline; it does not turn unresolved migration work into an unattended process.

For a foreground watcher:

```sh
overlord check
overlord watch
```

`watch` performs another synchronization immediately, then remains attached to the foreground terminal. `Ctrl-C`, `SIGINT`, or `SIGTERM` stops it gracefully. `watch --json` is unsupported.

Closing the terminal normally stops a foreground process. To keep it running across terminal disconnects, use a tool you already administer, such as `tmux`, and keep any logs outside managed roots:

```sh
tmux new-session -s overlord-watch
overlord watch
# Press Ctrl-b, then d, to detach. Reattach with:
tmux attach-session -t overlord-watch
```

`tmux` is not installed or managed by Overlord. A tmux-hosted watcher is still a foreground process and is not automatically recreated after login or reboot.

For a user-managed login-session service, first preview the exact service plan:

```sh
overlord check
overlord service install --dry-run
overlord service install
overlord service status
overlord service logs
```

The dry run and installation display the absolute Node and Git executables, Overlord CLI and arguments, allowlisted environment, service definition, receipt and log paths, and manager commands. Review those values before installation. `service install` creates a per-user LaunchAgent on macOS or per-user systemd unit on Linux; it never uses `sudo` or installs a root/system daemon. It does not enable Linux lingering, so availability outside a login session continues to follow the host's existing user-manager policy.

Only one watcher may run for a home directory. If the migration temporarily used the example tmux session, hand it off gracefully instead of installing a second watcher:

```sh
tmux attach-session -t overlord-watch
# Press Ctrl-C and wait for "watch: stopped", then exit the tmux shell.

overlord check
overlord service install --dry-run
overlord service install
overlord service status
```

Do not use `tmux kill-session` as the normal handoff. An explicit `Ctrl-C`, `SIGINT`, or `SIGTERM` lets the watcher close its watches and settle active synchronization before the service starts. If another watcher still owns the lifetime lock, the managed watcher cannot run; inspect `service status` and `service logs`, stop the old watcher, and retry installation.

The service pins physical absolute paths for the Node executable and built Overlord CLI used during installation. Re-run `service install --dry-run` and `service install` from the intended runtime after moving a Node installation, switching version-manager runtimes, moving the Overlord checkout, or rebuilding it at another path.

See [Background auto-sync service](background-service.md) for platform paths, receipt and tamper behavior, logging bounds, runtime upgrades, and uninstall guarantees.

## Checklist for a coding agent

When helping with an existing-machine migration:

1. Inventory configuration, managed paths, environment overrides, symlinks, and Git state before changing anything.
1. Propose a fresh backup outside all managed and discovery roots and confirm its destination before creating it.
1. Show the legacy configuration and proposed `roots` replacement; do not silently drop `external` entries.
1. Confirm that the user's request authorizes `init`, `sync`, and any root change, move, deletion, or conflict resolution; a request to inspect or diagnose alone does not.
1. Treat `status --json` as evidence. Report every scope, planned action, conflict, and invalid path.
1. Run `check` after synchronization and inspect project and native-repository Git changes.
1. Start auto-sync only after `check` is clean. For a foreground process, explain the terminal and `tmux` lifecycle; for a service, review its exact dry-run plan, stop any existing watcher, and explain runtime pinning and the platform login policy.
