# Overlord

Overlord keeps Claude Code and OpenAI Codex CLI skills and subagents in sync
from one Git-friendly `.agents` source of truth. It validates canonical
definitions, renders each provider's native agent format, inventories native
files, and reconciles differences without silently overwriting user work.

> **Distribution status:** Overlord is available as public source at
> [github.com/geekforbrains/overlord](https://github.com/geekforbrains/overlord).
> It is not currently published to npm. The npm package named `overlord`
> belongs to another project, so do not use `npm install overlord` or
> `npx overlord`. `package.json` remains private as a publication safeguard;
> the local executable is still named `overlord`.

```text
                    canonical source
              ~/.agents + <project>/.agents
                         |
              validate, render, reconcile
                    /           \
             Claude Code       Codex CLI
            skills + agents   skills + agents
```

## Why

- Maintain a skill or subagent once and use it with both tools.
- Build on the open [Agent Skills](https://agentskills.io/specification)
  convention instead of trapping definitions in a private format.
- Detect missing, conflicting, and unmanaged native files before changing them.
- Preserve provider-specific settings without pretending model names,
  permissions, or tool controls are portable.
- Expose a stable JSON workflow suitable for CI and agent-driven use.

## Install from source

Overlord requires Git, Node.js 22 or newer, and npm. Claude Code and Codex CLI
are optional individually; Overlord detects which providers are available.

Clone, validate, and build the public source:

```sh
git clone https://github.com/geekforbrains/overlord.git
cd overlord
npm ci
npm run check
node ./dist/cli.js --help
```

`npm run check` typechecks the source, runs the test suite, and builds
`dist/cli.js`. This installs Overlord's dependencies from npm; it does not
install or fetch the unrelated npm package named `overlord`.

### Run it from another project

Use the absolute path to the built CLI:

```sh
cd /path/to/my-project

node /absolute/path/to/overlord/dist/cli.js status --project "$PWD"
node /absolute/path/to/overlord/dist/cli.js init --project "$PWD"
node /absolute/path/to/overlord/dist/cli.js sync --project "$PWD" --dry-run
node /absolute/path/to/overlord/dist/cli.js sync --project "$PWD"
node /absolute/path/to/overlord/dist/cli.js check --project "$PWD"
```

The explicit `--project "$PWD"` is useful in scripts and agent-driven setup.
When omitted, Overlord selects the nearest `.agents` ancestor, then the Git
worktree root, then user scope.

To expose an `overlord` command locally without publishing to npm, optionally
link the built checkout:

```sh
cd /absolute/path/to/overlord
npm run check
npm link
overlord --help
```

`npm link` changes the current user's global npm links. Direct
`node /absolute/path/to/overlord/dist/cli.js ...` invocation avoids that global
change.

### Update a source checkout

```sh
cd /absolute/path/to/overlord
git status --short
git pull --ff-only
npm ci
npm run check
```

Resolve or preserve local changes before pulling. Because `dist/` is generated
and ignored by Git, rebuild after every source update.

### User-wide setup

User scope writes under `~/.agents` and may materialize provider-native files
under `~/.claude` and `~/.codex`:

```sh
node /absolute/path/to/overlord/dist/cli.js status --global
node /absolute/path/to/overlord/dist/cli.js init --global
node /absolute/path/to/overlord/dist/cli.js sync --global --dry-run
node /absolute/path/to/overlord/dist/cli.js sync --global
node /absolute/path/to/overlord/dist/cli.js check --global
```

Inspect the dry run before synchronizing. Automated agents should obtain
explicit approval before initializing, synchronizing, or otherwise modifying
user-global configuration.

## Ask an AI coding agent to set it up

Give Codex CLI, Claude Code, or another coding agent this prompt:

```text
Set up Overlord from its public source repository:

https://github.com/geekforbrains/overlord

Before changing anything:
1. Check whether a checkout already exists. Never delete or overwrite an
   existing checkout.
2. Read README.md, package.json, docs/spec.md, and any repository instruction
   files completely.
3. Verify that Git and Node.js 22 or newer are available.
4. If an existing checkout has uncommitted changes, stop and report them rather
   than pulling over them.

Clone the repository, or update a clean existing checkout with `git pull
--ff-only`. Run `npm ci` and `npm run check`. Do not install or execute the npm
package named `overlord`; it is unrelated to this repository.

After validation, show me:
- the checkout path;
- the exact direct `node .../dist/cli.js` command;
- the test and build results;
- whether Claude Code and Codex CLI were detected.

Do not run `npm link`, `overlord init --global`, `overlord sync --global`, or
edit anything under ~/.agents, ~/.claude, ~/.codex, CLAUDE_CONFIG_DIR, or
CODEX_HOME without my explicit approval. Ask which project I want to configure.
For that project, inspect status first, show `sync --dry-run`, and ask before
applying any destructive or conflict-resolution action.
```

## One source of truth

User definitions live in `~/.agents`; project definitions use the same layout
at `<project>/.agents`:

```text
.agents/
├── skills/
│   └── my-skill/
│       ├── SKILL.md
│       ├── scripts/
│       ├── references/
│       └── assets/
└── overlord/
    ├── overlord.yaml
    └── agents/
        └── reviewer.md
```

`skills/` follows the Agent Skills format. Codex reads canonical skills from
`.agents/skills` directly, so no Codex skill copy is created. Overlord
materializes the remaining provider-native outputs:

<!-- markdownlint-disable MD013 -->

| Canonical definition | Claude Code | Codex CLI |
| --- | --- | --- |
| User skill | `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/<name>/` | read directly from `~/.agents/skills/<name>/` |
| Project skill | `<project>/.claude/skills/<name>/` | read directly from `<project>/.agents/skills/<name>/` |
| User agent | `${CLAUDE_CONFIG_DIR:-~/.claude}/agents/<name>.md` | `${CODEX_HOME:-~/.codex}/agents/<name>.toml` |
| Project agent | `<project>/.claude/agents/<name>.md` | `<project>/.codex/agents/<name>.toml` |

<!-- markdownlint-enable MD013 -->

Overlord also scans `${CODEX_HOME:-~/.codex}/skills` and
`<project>/.codex/skills` for duplicates, but never writes skills there.
Codex's `.system` directory is excluded. Legacy `.claude/commands` entries are
reported as diagnostics and are not converted.

Canonical subagents use portable Markdown with YAML frontmatter:

```markdown
---
version: 1
name: reviewer
description: Reviews changes for correctness, regressions, and missing tests.
targets:
  claude:
    model: opus
    tools: [Read, Grep, Glob, Bash]
    color: cyan
  codex:
    model_reasoning_effort: high
    sandbox_mode: read-only
---

Review the requested change. Lead with actionable findings and cite files.
```

The name, description, and Markdown body are shared. Values below
`targets.claude` or `targets.codex` are preserved for that provider and are not
translated. Set a target to `false` to disable it for that agent.

## Everyday workflow

Overlord does not watch files or run a background service. Edit definitions in
the canonical `.agents` directory, then synchronize and verify them explicitly:

```sh
# User-wide definitions under ~/.agents
overlord sync --global
overlord check --global

# Definitions under the current project's .agents directory
overlord sync
overlord check
```

Codex reads canonical skills from `.agents/skills` directly. The sync step is
still required to materialize Claude skills and both providers' custom agents.
Start a new Claude or Codex session if an existing session does not reload a
changed definition.

### What if I create or edit a file under `.claude`?

A new Claude-only definition is reported as `unadopted`; Overlord does not copy
it into `.agents` automatically. Interactive `overlord sync` offers to adopt it.
For a user-wide skill in a non-interactive workflow, inspect the plan and apply
the exact selector returned in its `decision` field:

```sh
overlord sync --global --dry-run --json
overlord sync --global --resolve 'skill:my-skill@user=adopt'
overlord check --global
```

After adoption, make future edits in `.agents`. If the same definition already
exists there with different content, Overlord reports a `conflict` and asks
which copy should win. It never adopts, replaces, or deletes existing content
without an explicit decision.

## Commands

<!-- markdownlint-disable MD013 -->

| Command | Behavior |
| --- | --- |
| `overlord init` | Create canonical directories and a minimal configuration without overwriting existing definitions. `--global` also installs the bundled workflow skill. |
| `overlord status` | Inspect the selected scope. It exits 0 when inspection succeeds even if work is needed. |
| `overlord check` | Assert that definitions are synchronized. It exits 1 for missing, unadopted, conflicting, or invalid definitions. |
| `overlord sync` | Copy missing outputs and surface conflicts or native-only definitions for an explicit decision. |

<!-- markdownlint-enable MD013 -->

Common options are `--global`, `--project <path>`, `--json`, and `--strict`.
`init` and `sync` support `--dry-run`; `sync` also accepts repeatable
`--resolve <selector>=<side>` choices.

Without a scope flag, Overlord selects the nearest `.agents` ancestor, then the
Git worktree root, then user scope. JSON output includes the selected scope and
the evidence used to resolve it.

## Synchronization behavior

Missing outputs are safe and are created automatically. Existing native data is
never replaced or removed without a resolution:

- A differing canonical/native pair is `conflict` and may keep `agents`,
  `claude`, or `codex` when that source is applicable.
- A native-only definition is `unadopted` and may be adopted, recorded as
  external, explicitly deleted with a recoverable backup, or skipped.
- A configured `external` definition is inventoried but not modified.
- Cross-scope canonical collisions are reported without a resolution because
  Claude and Codex do not share one safe precedence rule.

For automation, first inspect the exact legal selectors and actions:

```sh
overlord sync --dry-run --json
overlord sync --resolve 'skill:verify@/absolute/project/path=agents'
overlord check --json
```

`--json` never prompts and writes one schema-versioned document to stdout,
including on errors. Human `sync` prompts only when stdin is a terminal;
skipping is the default. Mutating runs use per-scope locks, atomic replacement
where supported, and recoverable backups for destructive changes.

## Current limitations

- GitHub source distribution is available, but no npm package for this project
  has been published. The registry package named `overlord` is unrelated.
- The implementation targets macOS and Linux. Windows behavior has not been
  validated.
- Synchronization is explicit and stateless: there is no watcher, project
  registry, background service, or ownership database.
- Only filesystem-backed skills and custom subagents are managed. Built-in,
  plugin, organization-managed, marketplace, and session-only definitions are
  outside the inventory.
- `.claude/commands`, standalone MCP settings, rules, hooks, `CLAUDE.md`, and
  `AGENTS.md` are not synchronized.
- Native definitions that violate the portable naming rules must currently be
  renamed manually before adoption.
- Symlinked canonical roots and top-level definition symlinks are rejected so
  `.agents` remains the physical source of truth. Relative symlinks contained
  within a skill are preserved.
- A canonical Codex skill becomes visible as soon as it is saved under
  `.agents/skills`; `sync` cannot act as a staging gate for it.
- Provider releases can add native fields or alter discovery behavior. Unknown
  agent overlay fields are preserved with a warning, or rejected with
  `--strict`.

## Development

```sh
npm run typecheck
npm test
npm run build
# or all three
npm run check
```

The implementation uses pinned YAML, TOML, and schema-validation dependencies.
The test suite covers canonical validation, deterministic rendering,
round-tripping, scope selection, synchronization decisions, JSON schema output,
locking, backups, symlinks, and failure safety.

The provider adapter was smoke-tested on 2026-07-30 with Codex CLI 0.146.0 and
Claude Code 2.1.220 in an isolated temporary project. Codex discovered the
canonical project skill directly; Claude loaded both the materialized skill and
subagent; and the final `overlord check --json` reported both definitions
synced. Codex custom-agent runtime discovery remains documentation-validated
because this CLI version has no zero-model agent-listing endpoint.

## Provider references

- [OpenAI Codex: Skills](https://developers.openai.com/codex/skills/)
- [OpenAI Codex: Multi-agent and custom agents](https://developers.openai.com/codex/multi-agent/)
- [Claude Code: Skills](https://code.claude.com/docs/en/skills)
- [Claude Code: Custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Agent Skills specification](https://agentskills.io/specification)

See the [full specification](docs/spec.md) for the normative formats, scope
rules, state model, safety constraints, and CLI contract. The
[configuration schema](docs/schemas/config.schema.json) and
[CLI output schema](docs/schemas/output.schema.json) are part of that contract.
