# macOS quick start

This is the shortest supported path from a reviewed Overlord source release to automatic synchronization under the current user's macOS login session. It installs a LaunchAgent, never a root daemon. Do not use the unrelated npm package named `overlord`.

If this Mac already has skills or custom agents below `~/.agents`, `~/.claude`, `~/.codex`, or a project, stop here and follow [Migrating an existing machine](migrating-existing-machine.md). That inventory and conflict review must happen before unattended synchronization.

## 1. Install one exact source release

Install Node.js 22 or newer and Git, then clone the tag named on the GitHub release. Replace `<release-tag>` with that exact tag; do not silently substitute a moving branch when helping another user.

```sh
git clone --branch <release-tag> --depth 1 https://github.com/geekforbrains/overlord.git
cd overlord
npm ci
npm run check
npm link
overlord --version
```

`npm link` is optional; every command may instead use `node /absolute/path/to/overlord/dist/cli.js`. The service pins the physical Node, Git, and built CLI paths used during installation, so keep them in place. After moving those paths or upgrading to another release, rebuild and explicitly reinstall the service from the intended runtime.

## 2. Initialize and choose discovery roots

Initialize the user source, then edit the generated configuration:

```sh
overlord init
${EDITOR:-vi} ~/.agents/overlord/overlord.yaml
```

For projects kept below `~/Projects`:

```yaml
roots:
  - ~/Projects
```

Each root is searched recursively for supported project definitions. It is not permission to follow symlinks or manage arbitrary files in the projects.

## 3. Establish a reviewed clean baseline

`status --json` is the dry run for fleet synchronization; there is no separate `--dry-run` flag for `sync`.

```sh
overlord status --json
overlord sync
overlord check
```

Read every scope, proposed action, conflict, and diagnostic before the first `sync`. Do not let an assistant infer which side of a conflict should win. Overlord commits managed user-source changes in `~/.agents`, but never commits a project repository; inspect affected project working trees yourself.

Continue only when `overlord check` reports `check: ok`.

## 4. Preview and install auto-sync

Stop any foreground or `tmux`-hosted `overlord watch` first. Then review the complete LaunchAgent plan before installing it:

```sh
overlord service install --dry-run
overlord service install
overlord service status
overlord service logs
```

A healthy installation reports a current definition and a reachable, loaded, active, and enabled service. It runs exactly one watcher for the home directory. macOS may also show it in System Settings under Login Items or background activity.

The LaunchAgent has a different environment—and sometimes a different privacy context—from an interactive terminal. If `service logs` reports permission failures for protected, removable, or network-backed roots, review macOS Privacy & Security and Login Items, confirm the root is mounted, and retry. Overlord does not bypass those controls.

## 5. Verify automatic synchronization

Create or change a valid canonical skill below the intended scope's `.agents/skills/<name>/SKILL.md`, or a portable agent below `.agents/overlord/agents/<name>.md`. Do not run `overlord sync`: the service should reconcile it automatically. Verify with:

```sh
overlord status --json
overlord check
overlord service status
overlord service logs
```

For a project skill, Claude receives a physical copy at `.claude/skills/<name>`, while Codex reads `.agents/skills/<name>` directly. A portable project agent is rendered to both `.claude/agents/<name>.md` and `.codex/agents/<name>.toml` unless a target is disabled.

Filesystem events are hints. Most changes reconcile after the 750 millisecond quiet period, while a missed event or entirely new project is recovered by the full scan within about 30 seconds. A deletion is intentionally slower: the identical removal must survive a two-second grace period and a second inventory before it propagates.

Build a complete definition before placing it in a managed artifact root. For example, stage a skill below `<project>/.agents/.staging/<name>` and then rename the complete directory into `.agents/skills/<name>`. Creating an empty managed directory first can produce a temporary validation error in the append-only service log before the next clean cycle.

Synchronization proves file convergence, not provider activation. Start a fresh Claude or Codex session when testing a newly added definition. Codex project agents additionally require trust for the exact project or repository; trust for `~/Projects` is not inherited.

## 6. Operate and remove the service

Use these checks whenever auto-sync is in doubt:

```sh
overlord check
overlord service status
overlord service logs
```

The log view is a bounded historical snapshot. Old errors remain after their underlying problem is fixed, so current `check` and service status determine present health. macOS log retention is operator-managed for this release.

To remove only the owned LaunchAgent and receipt:

```sh
overlord service uninstall
```

Uninstall preserves definitions, configuration, reconciliation state, `~/.agents` Git history, project files, and logs. It refuses a foreign or modified service definition rather than forcing ownership. See [Background auto-sync service](background-service.md) for paths, runtime pinning, tamper behavior, and troubleshooting details.
