# Overlord

Overlord 0.2 keeps user-level and project-level Claude Code and OpenAI Codex CLI skills and custom agents synchronized across a configured fleet of directories. Each scope owns one Git-friendly `.agents` source; Overlord discovers those scopes, generates their provider-native outputs, and reports anything unsafe to change.

> **Distribution status:** Overlord is available as public source at [github.com/geekforbrains/overlord](https://github.com/geekforbrains/overlord), but it is not published to npm. The npm package named `overlord` is unrelated, so do not install or execute it.

## The fleet model

The user scope at `~/.agents` is always included. A short user-level configuration lists parent directories that Overlord searches recursively for independent project scopes:

```yaml
# ~/.agents/overlord/overlord.yaml
version: 2
roots:
  - ~/Projects
  - /Volumes/work/clients
```

Run `overlord init` once to create the user source, an empty `roots` configuration, and the bundled Overlord workflow skill, then edit the configuration to add the parent directories you trust.

Version 0.2 uses configuration version `2`. Replace a version 1 configuration with the fleet form above; legacy per-scope `external` entries are no longer supported.

`init` never overwrites an installed `overlord` skill. If an upgrade reports `modified-bundled-skill`, compare that file with `assets/overlord/SKILL.md` and replace it manually if it is the older bundled workflow rather than a customization you want to keep.

A configured root is only a discovery boundary. It is never treated as a project scope, and definitions found in its descendants are never copied into the root.

Within each root, Overlord discovers descendants whose skill or agent directories contain entries under one or more of these paths:

```text
.agents/skills/                 canonical skills
.agents/overlord/agents/       canonical agents
.claude/skills/                Claude-native skills
.claude/agents/                Claude-native agents
.codex/skills/                 Codex scan-only skills
.codex/agents/                 Codex-native agents
```

Sibling and nested projects remain independent. Discovery does not depend on Git, does not follow directory symlinks, and skips common repository, dependency, build, cache, and virtual-environment directories.

A missing, unreadable, symlinked, or non-directory discovery root is reported as an error diagnostic instead of being silently ignored.

The fleet commands ignore the current working directory and operate on the same scopes:

```sh
overlord status
overlord sync
overlord check
```

You can run those commands from anywhere on the machine.

## Canonical sources and provider outputs

User definitions live below `~/.agents`; every discovered project keeps its definitions below that project's `.agents` directory. These are the only editable definitions managed by Overlord:

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

This is the only supported layout: `.agents` contains source, while managed files below `.claude` and `.codex` are generated outputs. Managed artifact roots, definition directories, files, and skill payload entries must be physical filesystem objects; Overlord does not follow or preserve symlinks in managed paths. After adoption, edit the canonical `.agents` definition and run `sync` rather than editing provider output.

User-level `CLAUDE_CONFIG_DIR` and `CODEX_HOME` overrides are rejected when their physical paths would overlap a canonical or project artifact root, including through a symlink or filesystem case alias. This prevents one scope from importing, overwriting, or removing another scope's files.

## Synchronization behavior

`overlord sync` performs unambiguous work across every discovered scope:

- A valid canonical definition with a missing provider output is materialized automatically.
- A valid, unambiguous provider-native definition with no canonical source is treated as migration input, adopted into that same scope, and replicated to the other provider automatically.
- A redundant Codex scan-only skill is backed up and removed after its canonical adoption, leaving one source of truth. Current Codex releases do not scan `.codex/skills`, so this is cleanup of a stale copy rather than a fix for a double load.
- A conflict or invalid definition is reported and left untouched; other independent scopes continue synchronizing.
- A failed scope is reported without hoisting its definitions or blocking healthy sibling scopes.

Overlord never guesses which side of a conflict should win. Resolve the underlying files manually in the affected scope, keeping `.agents` as the intended canonical source, then run `sync` again.

Deleting a canonical definition does not propagate deletion to provider directories. A remaining valid native copy becomes stale migration input and can be adopted again on a later sync, so permanent deletion requires removing every generated copy too.

Mutations use per-scope locks. Individual files are published atomically, so a half-written agent file never appears at its destination. A skill directory is validated and staged first, but its entries are published one at a time, so a failure partway through leaves a partial skill directory in place and reports the paths it created as a completed action. Overlord does not delete entries it did not create, and it does not guarantee that a provider never sees a partially materialized skill.

Before a verified replacement or removal, Overlord atomically moves the displaced artifact into a fresh UUID directory under the adjacent provider control directory's physical `.overlord-backups` folder, such as `.codex/.overlord-backups/<uuid>/`; it refuses a symlinked or non-directory backup root and reports the exact backup path in human and JSON actions.

## Commands

| Command           | Behavior                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `overlord init`   | Initialize the always-present user scope, fleet configuration, and bundled workflow skill without overwriting a modified installed skill.  |
| `overlord status` | Discover every scope and report definitions, diagnostics, and proposed actions; inspection issues do not change its exit code from 0.      |
| `overlord check`  | Inspect the same fleet and exit 1 when any scope contains a missing, unadopted, conflicting, or invalid definition or an error diagnostic. |
| `overlord sync`   | Synchronize safe definitions across the fleet, auto-adopt unambiguous native definitions, and report unresolved issues.                    |

Commands accept `--json` for one schema-versioned JSON document on stdout. Help and installed-version output are available through `--help` and `--version`.

The JSON contract exposes a `scopes` array plus flat definitions, actions, diagnostics, and an aggregate summary. See [docs/schemas/output.schema.json](docs/schemas/output.schema.json).

## Install from source

Overlord requires Node.js 22 or newer and npm. Git is needed to clone and update the source checkout.

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
```

To expose `overlord` as a local command without publishing to npm, run `npm link` from the checkout. Direct `node /absolute/path/to/overlord/dist/cli.js ...` invocation avoids changing global npm links.

After pulling source updates, run `npm ci` and `npm run check` again because generated `dist/` output is ignored by Git.

## Development

```sh
npm run lint
npm run typecheck
npm test
npm run build

# Full gate
npm run check
```

The full check runs linting, typechecking, the test suite, and the production build. Tests cover configuration, recursive discovery, scope isolation, validation, deterministic rendering, adoption, conflicts, backups, symlink rejection, JSON output, and failure safety.

## Current limitations

- Synchronization runs only when a command is invoked; there is no watcher, daemon, or background service.
- Overlord does not propagate canonical deletions to provider outputs.
- Provider binaries and their installed versions are not detected; filesystem reconciliation does not prove that an existing provider session has reloaded a definition.
- Only filesystem-backed skills and custom agents are managed. Built-ins, plugins, marketplaces, organization policy, and session-only definitions remain outside the inventory.
- `.claude/commands`, standalone MCP settings, rules, hooks, `CLAUDE.md`, and `AGENTS.md` are not synchronized.
- The implementation targets macOS and Linux; Windows behavior has not been validated.
- The project is source-only until it owns a distinct npm package name.

## References

- [OpenAI Codex: Skills](https://developers.openai.com/codex/skills/)
- [OpenAI Codex: Multi-agent and custom agents](https://developers.openai.com/codex/multi-agent/)
- [Claude Code: Skills](https://code.claude.com/docs/en/skills)
- [Claude Code: Custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Agent Skills specification](https://agentskills.io/specification)

See the [full specification](docs/spec.md), [configuration schema](docs/schemas/config.schema.json), and [CLI output schema](docs/schemas/output.schema.json) for the complete public contract.
