# Overlord

Overlord keeps user-level and project-level Claude Code and OpenAI Codex CLI skills and custom agents synchronized across a configured fleet of directories. Every scope has its own durable `.agents` source and is reconciled independently, including changes made through a provider's native files.

> **Distribution status:** Overlord is available as public source at [github.com/geekforbrains/overlord](https://github.com/geekforbrains/overlord), but it is not published to npm. The npm package named `overlord` is unrelated, so do not install or execute it.

## The fleet model

The user scope at `~/.agents` is always included. A short user-level configuration lists parent directories that Overlord searches recursively for independent project scopes:

```yaml
# ~/.agents/overlord/overlord.yaml
roots:
  - ~/Projects
  - /Volumes/work/clients
```

Use `overlord init` as the normal first command. It creates the user source, creates or validates a dedicated physical Git repository at `~/.agents`, writes an empty `roots` configuration when needed, installs the bundled Overlord workflow skill, and records the managed source in an initial `overlord: initialize` commit. Repeating `init` validates the repository and creates no commit when the managed files are unchanged. Then edit the configuration to add the parent directories you trust.

The configuration is deliberately just `roots`; it has no version field or automatic migration flow.

> **Existing machine:** If `~/.agents` or provider-native definitions already exist, follow [Migrating an existing machine](docs/migrating-existing-machine.md) before running `init`. The guide covers inventory and off-fleet backups, legacy configuration, baseline-free conflicts, Git review, and starting auto-sync. Overlord does not migrate legacy configuration or choose a conflict winner for you.

> **macOS auto-sync:** For a new Mac, use the [macOS quick start](docs/macos-quickstart.md). It covers installing an exact source release, configuring roots, reviewing the first synchronization, installing the per-user LaunchAgent, and verifying automatic propagation without a manual `sync`.

A configured root is both a discovery boundary and a project candidate. If the root itself contains supported definitions, it is synchronized as a project; otherwise only matching descendants become project scopes. Definitions are never hoisted between a root and its descendants.

Within each root, Overlord discovers the root itself and descendants whose skill or agent directories contain entries under one or more of these paths:

```text
.agents/skills/                 canonical skills read directly by Codex
.agents/overlord/agents/       canonical agents
.claude/skills/                Claude-native skills
.claude/agents/                Claude-native agents
.codex/agents/                 Codex-native custom agents
```

Codex skills are discovered through `.agents/skills`; Codex custom agents are discovered through `.codex/agents`. `.codex/skills` is not a Codex skill location and is not inventoried by Overlord.

Sibling and nested projects remain independent. Discovery does not depend on Git, does not follow directory symlinks, and skips common repository, dependency, build, cache, and virtual-environment directories.

A missing, unreadable, symlinked, or non-directory discovery root is reported as an error diagnostic instead of being silently ignored.

The fleet commands ignore the current working directory and operate on the same scopes:

```sh
overlord status
overlord sync
overlord check
overlord watch
```

You can run those commands from anywhere on the machine. `watch` stays in the foreground and keeps the same fleet synchronized until it receives `SIGINT` or `SIGTERM`.

All four commands require an existing dedicated Git repository at `~/.agents`; `overlord init` normally establishes it. A valid manually initialized repository, including one without a first commit, is also accepted. `status` and `check` only validate the repository and inspect the fleet; they never create a repository, initialize synchronization metadata, stage files, or commit. A home without that repository is an error rather than an implicit initialization.

## Canonical sources and provider outputs

User definitions live below `~/.agents`; every discovered project keeps its definitions below that project's `.agents` directory. The scope-local `.agents` tree is the durable source after every successful synchronization:

```text
.agents/
├── skills/
│   └── my-skill/
│       ├── SKILL.md
│       ├── scripts/
│       ├── references/
│       └── assets/
└── overlord/
    ├── overlord.yaml           user scope only
    └── agents/
        └── reviewer.md
```

Skills use the [Agent Skills](https://agentskills.io/specification) directory format. Codex reads `.agents/skills` directly, while Overlord copies each canonical skill to a physical directory in Claude's skill location.

Claude's `skills/synced/` account downloads and `skills/.trash/` storage stay under Claude's control. Overlord excludes these names case-insensitively at user and project Claude skill roots, including configured Claude locations, and never imports their nested skills. Canonical skills cannot use these reserved names.

The synchronized skill value is its file paths, file bytes, and executable bits—the same information Git can preserve. Empty directories, directory permissions, and other non-executable permission differences are not treated as skill changes. A nested `.git` entry, including a case variant, is invalid because the owning source repository cannot preserve it as ordinary skill files.

Canonical agents are portable Markdown definitions. Overlord renders each enabled agent to Claude Markdown and Codex TOML while preserving provider-specific fields under its target overlay.

```markdown
---
version: 1
name: reviewer
description: Reviews changes for correctness, regressions, and missing tests.
targets:
  claude:
    model: opus
    tools: [Read, Grep, Glob, Bash]
  codex:
    model_reasoning_effort: high
    sandbox_mode: read-only
---

Review the requested change. Lead with actionable findings and cite files.
```

Set a target to `false` when an agent should not be rendered for that provider.

| Definition    | Claude Code                                        | Codex CLI                                    |
| ------------- | -------------------------------------------------- | -------------------------------------------- |
| User skill    | `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/<name>/`   | read from `~/.agents/skills/<name>/`         |
| Project skill | `<project>/.claude/skills/<name>/`                 | read from `<project>/.agents/skills/<name>/` |
| User agent    | `${CLAUDE_CONFIG_DIR:-~/.claude}/agents/<name>.md` | `${CODEX_HOME:-~/.codex}/agents/<name>.toml` |
| Project agent | `<project>/.claude/agents/<name>.md`               | `<project>/.codex/agents/<name>.toml`        |

Overlord reconciles these filesystem locations directly. It does not detect, invoke, or require either provider binary.

Synchronization proves that the files agree; provider activation remains separate. In current Codex releases, project custom agents below `.codex/agents` are loaded only when the exact project or repository is trusted—trust for a parent such as `~/Projects` is not inherited—and a fresh Codex session is required after adding or changing an agent. Establish trust through Codex itself; Overlord does not create or modify provider trust settings. See the [Codex custom-agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents).

This is the only supported layout. Intentional edits should normally be made in `.agents`, but provider-native files are tracked synchronization endpoints because Claude or Codex may create, modify, or delete them while helping the user. Overlord incorporates an unambiguous native change into the same scope's `.agents` source before updating its other endpoints. Managed artifact roots, definition directories, files, and skill payload entries must be physical filesystem objects; Overlord does not follow or preserve symlinks in managed paths.

The user source at `~/.agents` is the only Git repository Overlord owns. Its `.git` entry must be a physical directory whose work-tree top level is exactly `~/.agents`; Git worktree files, symlinked metadata, and repositories pointed at another work tree are rejected. Overlord never initializes, stages, commits, changes ignore rules in, pushes, or otherwise maintains a discovered project's Git repository. A project-side import may therefore leave ordinary `.agents` working-tree changes for that project to manage itself.

User-level `CLAUDE_CONFIG_DIR` and `CODEX_HOME` overrides are rejected when their physical paths would overlap a canonical or project artifact root, including through a symlink or filesystem case alias. This prevents one scope from importing, overwriting, or removing another scope's files.

## Synchronization behavior

Overlord records the last successfully synchronized content for every definition and endpoint in machine-local ledger files below `~/.agents/.git`. On the next `sync`, it compares the current canonical and native content with that baseline:

- When only canonical content changed, Overlord updates that scope's provider outputs.
- When only one provider endpoint changed, Overlord incorporates the change into that scope's canonical definition and updates its other endpoints.
- A new definition created in canonical or by a provider is added to the other locations in that scope.
- Deleting a previously synchronized definition from one location deletes its counterparts in the same scope when no concurrent edit exists.
- Absence in a newly discovered scope is not a deletion; existing canonical content is materialized there first.
- Incompatible concurrent edits, including modification versus deletion, are conflicts and remain untouched.
- A failed or conflicting scope does not hoist changes into the user scope or block healthy sibling projects.

The same name may have unrelated content in the user scope and multiple projects. A change to `~/Projects/A/.claude/skills/foo` can update only `~/Projects/A/.agents/skills/foo`; it never changes `~/.agents/skills/foo` or Project B.

The ledger is private synchronization metadata. It is not canonical content, is never written into a project, and has no public schema, version, or migration contract. `status` and `check` read it without creating or updating it.

During `sync`, Overlord applies all safe user-canonical changes first, stages the changed fleet configuration and canonical paths selected by reconciliation, and creates at most one `overlord: synchronize` commit before changing any user provider output. Fixed output reports the commit SHA, any originating endpoints, and every committed canonical file; no LLM composes the message or selects files. Other staged or working-tree content is excluded and preserved. A clean/no-op sync creates no commit, and Overlord never pushes. If the user commit fails, provider propagation and ledger advancement for those changes stop, leaving the canonical changes visible for diagnosis and retry. Project scopes use the same machine-local ledger but receive no Git operations.

Mutations use per-scope locks. Individual files are published atomically, so a half-written agent file never appears at its destination. A skill directory is validated and staged first, but its entries are published one at a time, so a failure partway through leaves a partial skill directory in place and reports the paths it created as a completed action. Overlord does not delete entries it did not create, and it does not guarantee that a provider never sees a partially materialized skill.

### Auto-sync

`overlord watch` provides auto-sync as a foreground process on macOS and Linux. It begins with a complete synchronization, then watches the exact managed canonical and provider artifact roots for the user and every discovered project. Watch events are invalidation hints rather than mutation instructions: Overlord waits for a 750 ms quiet period, then inventories and synchronizes the full fleet again.

The watcher does not recursively monitor entire configured discovery roots. Instead, it performs a full discovery rescan every 30 seconds, which finds new projects and refreshes the exact managed-root watch set even if no filesystem event arrived. Events that occur during a synchronization are coalesced into a subsequent cycle.

After the initial synchronization, a watcher cycle does not immediately execute a newly observed removal action. The same complete removal action must remain present after a two-second grace period and a second full cycle before it can proceed. If that action changes or disappears, confirmation starts over; each additional removal action requires its own confirmation.

`SIGINT` and `SIGTERM` stop the foreground loop gracefully by closing its watchers and timers and allowing active synchronization work to settle. A home-scoped lifetime lock allows only one watcher at a time, so a foreground process, a `tmux` process, and a managed service cannot reconcile the same fleet concurrently. On macOS and Linux, the lock uses a fixed per-UID root below `/tmp`, independent of `TMPDIR`, so terminal and service-manager environments share the same lock identity.

For login-session auto-sync, `overlord service` installs the same watcher as a user-level LaunchAgent on macOS or user systemd unit on Linux. It never installs a root or system service. Installation requires a clean fleet baseline, previews the exact pinned runtime and allowlisted environment, and uses an ownership receipt to refuse unowned or modified service definitions. See [Background auto-sync service](docs/background-service.md) for installation, logs, runtime relocation, Linux linger policy, and safe uninstall behavior.

## Commands

| Command           | Behavior                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `overlord init`   | Create or validate the dedicated user repository, initialize managed files and private ledger state, and make the initial managed commit.  |
| `overlord status` | Require the user repository, inspect without mutation, and report definitions, diagnostics, and proposed actions; attention still exits 0. |
| `overlord check`  | Require the user repository, perform the same read-only inspection, and exit 1 when attention is required.                                 |
| `overlord sync`   | Require the user repository, reconcile safe changes, commit user-source changes before provider propagation, and report conflicts.          |
| `overlord watch`  | Run an initial sync, then keep the fleet synchronized in the foreground until interrupted.                                                   |
| `overlord service install [--dry-run]` | Preview or install, enable, and start the current user's auto-sync service after a clean baseline check.                       |
| `overlord service status` | Inspect service ownership, the pinned runtime, and manager state without mutation.                                                   |
| `overlord service logs` | Print a bounded recent view of timestamped service output without following it.                                                         |
| `overlord service uninstall` | Stop, disable, and remove only the unchanged Overlord-owned service definition and receipt.                                        |

The one-shot `init`, `status`, `check`, and `sync` commands accept `--json` for one schema-versioned JSON document on stdout. `watch --json` and `service --json` are unsupported; service commands are intentionally human-only. Help and installed-version output are available through `--help` and `--version`.

The JSON contract exposes a `scopes` array plus flat definitions, actions, diagnostics, and an aggregate summary. See [docs/schemas/output.schema.json](docs/schemas/output.schema.json).

## Install from source

Overlord requires Node.js 22 or newer, npm, and Git. Git is both an installation dependency and the history mechanism for `~/.agents`.

```sh
git clone https://github.com/geekforbrains/overlord.git
cd overlord
npm ci
npm run check
node ./dist/cli.js --help
```

Use the absolute path to the built CLI from anywhere:

```sh
node /absolute/path/to/overlord/dist/cli.js init
nvim ~/.agents/overlord/overlord.yaml
node /absolute/path/to/overlord/dist/cli.js status
node /absolute/path/to/overlord/dist/cli.js sync
node /absolute/path/to/overlord/dist/cli.js check
node /absolute/path/to/overlord/dist/cli.js watch
node /absolute/path/to/overlord/dist/cli.js service install --dry-run
```

To expose `overlord` as a local command without publishing to npm, run `npm link` from the checkout. Direct `node /absolute/path/to/overlord/dist/cli.js ...` invocation avoids changing global npm links. Service installation resolves and pins the physical absolute Node executable and built CLI used for that invocation, and records the resolved physical Git executable; reinstall the service after relocating either runtime.

After pulling source updates, run `npm ci` and `npm run check` again because generated `dist/` output is ignored by Git.

For a friend-facing release install, check out the exact release tag rather than a moving branch. The package rebuilds `dist/` before `npm pack`, but source users should still run the full check before linking or installing the service.

## Development

```sh
npm run lint
npm run typecheck
npm test
npm run build

# Full gate
npm run check
```

The full check runs linting, typechecking, the test suite, and the production build.

## Current limitations

- The launchd path has been exercised end-to-end on Apple Silicon macOS, including automatic project discovery, bidirectional skill synchronization, portable-agent rendering, deletion grace, singleton locking, and `KeepAlive` restart. Intel macOS and actual logout/login or reboot recovery still need broader tester coverage.
- Linux systemd support has automated renderer and lifecycle coverage but has not yet completed the same real-host validation matrix; treat it as beta until that evidence exists.
- Background auto-sync is per-user only: macOS uses a LaunchAgent and Linux uses a user systemd unit. Overlord does not install a root/system service or enable Linux lingering.
- Provider binaries and their installed versions are not detected; filesystem reconciliation does not prove that an existing provider session has reloaded a definition.
- Only filesystem-backed skills and custom agents are managed. Built-ins, plugins, marketplaces, organization policy, and session-only definitions remain outside the inventory.
- `.claude/commands`, standalone MCP settings, rules, hooks, `CLAUDE.md`, and `AGENTS.md` are not synchronized.
- Overlord never commits or pushes a discovered project's repository; only `~/.agents` receives automatic commits.
- The implementation targets macOS and Linux; Windows behavior has not been validated.
- The project is source-only until it owns a distinct npm package name.

## References

- [OpenAI Codex: Skills](https://developers.openai.com/codex/skills/)
- [OpenAI Codex: Multi-agent and custom agents](https://developers.openai.com/codex/multi-agent/)
- [Claude Code: Skills](https://code.claude.com/docs/en/skills)
- [Claude Code: Custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Agent Skills specification](https://agentskills.io/specification)

See the [macOS quick start](docs/macos-quickstart.md), [Migrating an existing machine](docs/migrating-existing-machine.md), [Background auto-sync service](docs/background-service.md), the [changelog](CHANGELOG.md), [full specification](docs/spec.md), [configuration schema](docs/schemas/config.schema.json), and [CLI output schema](docs/schemas/output.schema.json) for the complete public contract and operational guidance.
