# Overlord specification

Status: Implemented development draft 0.5 (public source; npm unpublished)
Last updated: 2026-07-30

This document specifies the initial Overlord product and current public-source
implementation. Command names and file formats remain a draft public contract
for version 0.1. The GitHub repository and executable are named `overlord`.
The npm registry name is separate, remains undecided, and `package.json` stays
private to prevent accidental publication.

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used
normatively.

Draft 0.5 narrows version 0.1 to explicit, stateless synchronization. It removes
materialization receipts, automatic deletion, renderer migration, project-root
discovery, and background watching. It also reduces the CLI to `init`, `status`,
`check`, and `sync`, and removes machine-local configuration.

Section 20 records what was verified on real installations and what was not.

## Contents

- [1. Summary](#1-summary)
- [2. Goals](#2-goals)
- [3. Non-goals for version 0.1](#3-non-goals-for-version-01)
- [4. Terminology](#4-terminology)
- [5. Canonical source and scope](#5-canonical-source-and-scope)
  - [5.1 User scope](#51-user-scope)
  - [5.2 Project scope](#52-project-scope)
  - [5.3 Resolving the current project](#53-resolving-the-current-project)
  - [5.4 Cross-scope name collisions](#54-cross-scope-name-collisions)
  - [5.5 Configuration](#55-configuration)
  - [5.6 Target availability](#56-target-availability)
- [6. Canonical skill format](#6-canonical-skill-format)
- [7. Canonical agent format](#7-canonical-agent-format)
  - [7.1 Common fields](#71-common-fields)
  - [7.2 Target overlays](#72-target-overlays)
  - [7.3 Portable agent names](#73-portable-agent-names)
- [8. Native locations and rendering](#8-native-locations-and-rendering)
  - [8.1 Locations Overlord writes](#81-locations-overlord-writes)
  - [8.2 Locations Overlord scans but never writes](#82-locations-overlord-scans-but-never-writes)
  - [8.3 Other native discovery behavior](#83-other-native-discovery-behavior)
  - [8.4 Rendering](#84-rendering)
  - [8.5 Deterministic rendering](#85-deterministic-rendering)
- [9. Comparison and state model](#9-comparison-and-state-model)
  - [9.1 Comparison rules](#91-comparison-rules)
  - [9.2 States](#92-states)
  - [9.3 `status` and `check`](#93-status-and-check)
- [10. The `sync` walk](#10-the-sync-walk)
  - [10.1 Rules](#101-rules)
  - [10.2 Resolution selectors](#102-resolution-selectors)
  - [10.3 Constraints](#103-constraints)
  - [10.4 Adoption](#104-adoption)
- [11. External definitions](#11-external-definitions)
- [12. Explicit operating model](#12-explicit-operating-model)
- [13. CLI contract](#13-cli-contract)
  - [13.1 Exit codes](#131-exit-codes)
- [14. Machine-readable and LLM-friendly output](#14-machine-readable-and-llm-friendly-output)
- [15. Concurrency and safety](#15-concurrency-and-safety)
- [16. Bundled `overlord` skill](#16-bundled-overlord-skill)
- [17. Expected operating behavior](#17-expected-operating-behavior)
- [18. Version 0.1 acceptance criteria](#18-version-01-acceptance-criteria)
- [19. Release limitations and deferred decisions](#19-release-limitations-and-deferred-decisions)
- [20. Verification record](#20-verification-record)
  - [20.1 Verified on a real installation](#201-verified-on-a-real-installation)
  - [20.2 Verified from primary documentation only](#202-verified-from-primary-documentation-only)
  - [20.3 Primary references](#203-primary-references)

## 1. Summary

Overlord keeps one definition of a skill or subagent and makes it work in both
Claude Code and OpenAI Codex CLI. The canonical source is a Git-friendly
`.agents` directory. Overlord compares it against each tool's native locations
and reconciles the difference.

The product is a synchronizer, not a translator. It normalizes only what the
two tools genuinely share — a skill's directory, and an agent's name,
description, and instruction body. Everything else is passed through to the
target that owns it.

Overlord manages persistent user and project definitions. It does not claim to
control built-in, organization-managed, plugin-provided, marketplace, or
session-only behavior that the target tools may expose.

Version 0.1 supports:

- Claude Code skills and custom subagents.
- Codex CLI skills and custom subagents.
- User-global and project-local scopes.
- Adoption of existing native definitions through the same `sync` command.
- Explicit status, validation, and synchronization of one selected scope.
- Human-readable and stable machine-readable output.

## 2. Goals

1. Make one canonical definition usable by Claude Code and Codex CLI.
2. Build on the open Agent Skills directory convention rather than inventing a
   private one, so removing Overlord does not strand the user's work.
3. Detect unmanaged files and target-side edits instead of hiding them.
4. Allow explicit exceptions for definitions managed by an organization or
   another system.
5. Make every decision and proposed mutation understandable to an LLM.
6. Avoid lossy attempts to normalize target features that are not equivalent.
7. Keep the canonical source suitable for Git and for syncing between machines.

## 3. Non-goals for version 0.1

- Claude legacy commands in `.claude/commands/`. Overlord reports them; it does
  not manage or convert them.
- Standalone MCP-server, rules, hook, `AGENTS.md`, or `CLAUDE.md` configuration.
  Hook and MCP fields embedded in an agent definition are carried through as
  ordinary target overlay data; see section 7.2.
- Other agent tools or editors.
- Translating model names, permissions, or tool capabilities between targets.
- Managing target built-ins, plugins, marketplaces, organization policy, or
  ephemeral session agents.
- Automatically committing, pulling, pushing, or resolving Git changes.
- Discovering projects, watching files, or running a background service.
- Automatically deleting native definitions whose canonical source disappeared.
- Automatically migrating output after a renderer or serializer changes.
- Keeping a persistent ownership database of generated files.
- Treating a recommendation emitted for an LLM as authorization to execute it.

## 4. Terminology

- **Canonical source**: an `.agents` directory containing the definitions
  Overlord manages.
- **Native output**: a file or directory Overlord materializes in a Claude or
  Codex native location.
- **Target**: `claude` or `codex` in version 0.1.
- **Scope**: either `user` or `project`.
- **Adapter**: the code that maps a canonical definition to or from one target's
  native format.

## 5. Canonical source and scope

### 5.1 User scope

The user source is fixed at `~/.agents`:

```text
~/.agents/
├── skills/
│   └── <name>/
│       ├── SKILL.md
│       ├── scripts/
│       ├── references/
│       └── assets/
└── overlord/
    ├── overlord.yaml
    └── agents/
        └── <name>.md
```

`~/.agents/skills/` is the location defined by the Agent Skills convention and
is read natively by Codex CLI. It is simultaneously Overlord's canonical skill
source and Codex's native skill directory; Overlord MUST NOT copy skills to any
other Codex location.

Version 0.1 has no override for the user canonical source. Codex discovers
personal skills at `~/.agents/skills/`; relocating the directory would break the
no-copy guarantee unless Codex gained and Overlord configured another supported
skill root.

Overlord's own files live under `~/.agents/overlord/` so that Overlord does not
place non-standard files directly in a shared standard directory. Subagents live
there because no cross-tool subagent standard exists; see section 7.

### 5.2 Project scope

A project source is rooted at `<project>/.agents`, with the same layout:

```text
<project>/.agents/
├── skills/
└── overlord/
    ├── overlord.yaml
    └── agents/
```

`overlord.yaml` is optional at project scope when defaults are sufficient.

### 5.3 Resolving the current project

For a command not forced to user scope with `--global`, Overlord MUST resolve
scope in this order:

1. An explicit `--project <path>`.
2. The nearest ancestor containing `.agents`.
3. The current Git worktree root, if any.
4. User scope.

The selected scope and the evidence used to select it MUST appear in verbose and
JSON output. Ordinary commands MUST NOT recursively inspect descendants of the
current project.

### 5.4 Cross-scope name collisions

If user-scope and project-scope definitions of the same kind share a name but
differ in content, Overlord MUST report a `conflict` and MUST NOT attempt to
resolve it by precedence. A skill and an agent may share a name without
colliding.

This is not caution about an unknown: the targets are known to disagree.

- Claude resolves same-named *skills* personal-over-project, but same-named
  *subagents* project-over-user. The two artifact types use opposite orders.
- Codex does not merge same-named skills at all. Both entries are presented to
  the model under the same name.

No single Overlord behavior can make the two tools agree, so the collision is
surfaced for a human decision. Identical definitions MAY be reported as
redundant rather than conflicting.

A cross-scope collision has no `--resolve` side. Both sides are canonical, and
section 10.2 offers no option that would discard one of them. It is cleared by
renaming or removing a definition, and `check` MUST keep failing until it is.

### 5.5 Configuration

`overlord.yaml` has two top-level keys. The formal schema is
`docs/schemas/config.schema.json`; implementations MUST validate against it on
load and MUST report the offending key path on failure.

```yaml
version: 1

external:
  - kind: skill                # skill | agent
    name: company-review
    target: claude             # optional for skills, required for agents
    reason: Installed by company policy
```

`version` identifies the configuration schema. `external` records definitions
owned by another system; section 11 defines its entries.

Configuration is scope-owned. The user file describes user-scope exceptions and
the selected project's file describes project-scope exceptions. An external
entry's scope is therefore inferred from the file containing it and is not
repeated in the entry. When checking a project, Overlord reads both files so it
can detect cross-scope collisions.

Version 0.1 has no machine-local configuration or configurable native paths.
Native roots come from `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or the defaults in
section 8.1. This keeps cloned configuration portable and avoids a precedence
system whose only purpose would be overriding environment variables.

### 5.6 Target availability

A target may be absent from the machine actually running the command, after an
uninstall or on a workstation that uses only one tool. This is expected rather
than exceptional.

Overlord detects target availability on every run. It MUST NOT fail solely
because a target is absent. It MUST warn, skip rendering and scanning for that
target, leave any existing output untouched, and report the target as
unavailable. Definitions for an unavailable target MUST NOT be reported
`missing`.

Both adapters are active when their targets are available. The per-agent
`targets` field in section 7.1 can still disable an otherwise available target.

## 6. Canonical skill format

A skill uses the standard Agent Skills directory format and requires no
Overlord-specific schema:

```text
skills/example-skill/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

The directory MAY contain any files allowed by the skill specification. In
version 0.1:

- `SKILL.md` MUST contain valid YAML frontmatter with `name` and `description`.
- The directory name MUST equal `name`.
- Names MUST satisfy the Agent Skills rule: 1–64 characters; lowercase ASCII
  letters, digits, and hyphens; no leading, trailing, or consecutive hyphen.
- Overlord MUST NOT rewrite, reformat, or annotate a skill's contents.

Skills are always shared by both targets. Version 0.1 has no per-skill target
selection: a skill in the canonical source is made available to Claude and
Codex. A definition genuinely specific to one tool SHOULD be left in that tool's
native directory and declared `external` (section 11).

Because skills are copied verbatim, Overlord MUST NOT insert a generated-file
banner or any other marker into a skill directory. Doing so would make the
canonical and materialized copies differ and would break the comparison in
section 9.

Target-specific frontmatter is copied unchanged. A field known to be meaningful
to only one target SHOULD produce a warning, not an error; the other target
ignores frontmatter it does not recognize. The standards-defined `allowed-tools`
field is experimental and its enforcement varies between clients: Overlord MAY
copy it unchanged but MUST report that it does not provide a portable permission
guarantee.

Codex skills MAY carry an `agents/openai.yaml` sidecar containing Codex-specific
display metadata. Overlord treats it as an ordinary file within the skill
directory and copies it verbatim.

## 7. Canonical agent format

An agent is Markdown with YAML frontmatter. The Markdown body is the common
instruction text.

```markdown
---
version: 1
name: code-review-agent
description: Reviews a change for correctness, regressions, and missing tests.
targets:
  claude:
    model: opus
    tools: [Read, Grep, Glob, Bash]
    color: cyan
  codex:
    model_reasoning_effort: high
    sandbox_mode: read-only
---

Review the requested change. Lead with actionable findings and cite exact files.
```

Subagents are stored under `.agents/overlord/agents/` rather than
`.agents/agents/`. A third-party draft convention already claims
`.agents/agents/` for a different, incompatible layout — a directory per agent
containing `agent.md` and `config.json`. Overlord does not squat a path whose
format it would contradict. If a subagent standard is ratified later, Overlord
adds it as another render target; the canonical source does not move.

### 7.1 Common fields

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Canonical schema version. Version 0.1 accepts `1`. |
| `name` | yes | Stable agent name and file stem. |
| `description` | yes | Target discovery/delegation description. |
| `targets` | no | Target enablement and native target fields. |
| Markdown body | yes | Common agent instructions. |

Both targets are enabled by default. A target MAY be disabled explicitly:

```yaml
targets:
  claude: false
  codex:
    sandbox_mode: read-only
```

### 7.2 Target overlays

The only normalized agent concepts in version 0.1 are name, description,
instruction body, and target enablement. Everything below `targets.claude` or
`targets.codex` is an adapter-owned native setting.

Overlord MUST NOT invent generic equivalents for model names, tool permissions,
sandbox modes, colors, or reasoning effort.

An unrecognized overlay field MUST NOT block validation or rendering. Overlord
MUST emit a prominent warning and MUST pass the field through to its target
unchanged:

```text
warning  reviewer.md: unknown field 'tols' for target claude
         did you mean 'tools'? (passing through unchanged)
```

Strict rejection is not viable and would not be correct. Claude's subagent
frontmatter set grows continuously across releases, and Codex custom agent files
accept arbitrary `config.toml` keys — an open set that cannot be enumerated.
Blocking on unknown fields would make every target release break Overlord until
Overlord shipped an update.

Overlord SHOULD maintain a known-field list per target so it can suggest
corrections for probable typos. `--strict` MUST make unrecognized fields a
validation failure, for use in CI.

A field that Overlord recognizes but cannot represent in the target's output
format is genuine lossiness and MUST fail the render.

Claude subagent frontmatter includes `hooks` and `mcpServers`, and Codex agent
files accept `mcp_servers`. These pass through as ordinary overlay data. The
section 3 non-goal concerns standalone hook and MCP configuration files, not
fields embedded in an agent definition.

### 7.3 Portable agent names

Agent names use the stricter documented common denominator of the two targets:

- 1–64 characters.
- Lowercase ASCII letters and hyphens only.
- MUST NOT start or end with a hyphen.
- MUST NOT contain consecutive hyphens.

An agent's file stem MUST equal its `name`. Skills retain the Agent Skills name
rule in section 6, which also permits digits. The rules are intentionally
separate: the Agent Skills convention does not define subagent names, and Claude
Code does not currently document digits as valid in subagent identifiers.

Neither target requires the file stem to match, because both resolve identity
from the `name` field. Overlord requires it anyway: Claude scans agent
directories recursively and, when two files in one tree declare the same name,
loads one of them "chosen by filesystem read order rather than a documented
precedence." A one-to-one stem-to-name mapping makes that ambiguity
unreachable.

Importing a native definition whose name violates the rule for its kind requires
the user to approve a portable rename.

## 8. Native locations and rendering

Environment-variable expansion occurs at runtime. Tildes below mean the current
user's home directory.

### 8.1 Locations Overlord writes

| Target | Scope | Artifact | Destination |
| --- | --- | --- | --- |
| Claude | user | skills | `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/<name>/` |
| Claude | project | skills | `<project>/.claude/skills/<name>/` |
| Claude | user | agents | `${CLAUDE_CONFIG_DIR:-~/.claude}/agents/<name>.md` |
| Claude | project | agents | `<project>/.claude/agents/<name>.md` |
| Codex | user | agents | `${CODEX_HOME:-~/.codex}/agents/<name>.toml` |
| Codex | project | agents | `<project>/.codex/agents/<name>.toml` |

Codex skills have no row. Codex reads `~/.agents/skills/` and
`<project>/.agents/skills/` directly, which are the canonical source. Writing a
second copy elsewhere would create the duplicate described in section 8.2.

### 8.2 Locations Overlord scans but never writes

Codex reads four skill directories. Two are canonical; the other two MUST be
inventoried and MUST NOT be written to:

| Path | Treatment |
| --- | --- |
| `${CODEX_HOME:-~/.codex}/skills/` | scan-only |
| `<project>/.codex/skills/` | scan-only |

Codex does not deduplicate same-named skills across these locations. A skill
named `deploy` present in both `~/.agents/skills/` and `~/.codex/skills/` is
presented to the model twice, under one name, with different content and no
warning. Overlord MUST report such a pair as a `conflict`.

This is a live hazard rather than a theoretical one: Codex ships a built-in
`skill-installer` skill that installs into `$CODEX_HOME/skills`.

`${CODEX_HOME:-~/.codex}/skills/.system/` holds Codex's built-in skills as real
directories on disk. Overlord MUST skip `.system` by an explicit rule, not by
relying on a general dotfile filter.

### 8.3 Other native discovery behavior

The destinations above are what Overlord materializes. They do not describe
every native discovery rule:

- Codex scans `.agents/skills` and `.codex/skills` from the current working
  directory through its repository ancestors.
- Claude scans project skill directories through repository ancestors and can
  discover nested skill directories on demand while working below the starting
  directory. Across standard scopes its documented skill priority is enterprise,
  then personal, then project; plugin skills are namespaced.
- Claude discovers project agent directories through repository ancestors and
  recursively scans agent subdirectories. The closest project definition wins
  among nested project directories. Managed and session-provided definitions can
  outrank project and user files and are outside Overlord's ownership.
- Claude also reads `.claude/commands/`, which is functionally equivalent to a
  skill. Overlord MUST report such files as `unmanaged-claude-command`
  diagnostics and MUST NOT convert them in version 0.1. They are outside the
  definition state model and MUST NOT make `check` fail.

For the selected user or project scope, Overlord MUST inventory the native
locations in sections 8.1 and 8.2 and classify rather than overwrite them. It
MUST NOT recursively inspect unrelated descendant projects.

### 8.4 Rendering

Skills are copied without format conversion.

Agents render as:

- Claude: a native Markdown subagent file with supported YAML frontmatter.
- Codex: a native TOML agent file, with the common Markdown body mapped to the
  target's `developer_instructions` field.

### 8.5 Deterministic rendering

Rendering MUST be deterministic. The same canonical definition MUST produce
byte-identical output on any machine and on any run of the same released adapter
contract.

Specifically, generated output MUST NOT contain timestamps, hostnames, user
names, absolute paths, or a version string that changes between releases. Line
endings MUST be LF with a single trailing newline. Executable bits and relevant
file permissions MUST be preserved.

Key ordering is fixed:

1. `name`, then `description`.
2. All remaining scalar keys, sorted alphabetically.
3. For TOML only, tables and arrays of tables last. This is a format
   requirement, not a preference: once a table header is emitted, every
   subsequent key belongs to it. The writer determines table-ness from the
   parsed type — an object becomes a table, anything else a scalar.

For Codex agents, `developer_instructions` is emitted last among scalars so the
head of the file stays readable.

Further rules that determinism depends on:

- Array contents MUST retain their authored order and MUST NOT be sorted.
- Values MUST be serialized according to their target format and parsed type.
  In particular, TOML strings are always quoted using a valid TOML string form;
  a string such as `opus` MUST NOT be emitted as a bare value.
- A body containing a TOML multiline delimiter MUST be escaped or emitted using
  another valid TOML string form.
- Absent fields MUST be omitted entirely. An unset value and an empty value MUST
  NOT both be reachable.

Implementations SHOULD use well-tested YAML and TOML serializers for both
reading and writing. They MUST construct maps in the required key order, pin the
serializer version for the 0.1 release. If a later dependency or adapter change
changes rendered bytes, existing output is an ordinary `conflict`; version 0.1
does not migrate it automatically. Writing an open-ended TOML serializer inside
Overlord is outside version 0.1's scope.

Round-tripping MUST be property-tested: rendering a canonical definition,
parsing the result, and rendering again MUST produce byte-identical output.

Determinism is what allows Overlord to answer "is this file current?" by
re-rendering and comparing without retaining prior state.

Overlord MUST NOT rewrite a file whose rendered content is unchanged, so
unchanged output retains its modification time.

A Codex TOML agent file SHOULD carry a fixed-string generated-file comment. A
Claude Markdown agent file SHOULD NOT: its body is the system prompt, and a
banner there would alter the agent's behavior. Skills MUST NOT be annotated at
all (section 6).

## 9. Comparison and state model

Overlord determines state directly from the canonical source and native
locations on every invocation. It does not retain ownership records, canonical
content, or native content between runs.

### 9.1 Comparison rules

- **Skills** compare as a directory tree, byte for byte. Operating-system
  artifacts such as `.DS_Store` MUST be ignored.
- **Agents** compare by rendering the canonical definition and comparing that
  render to the native file, byte for byte. Canonical and native are different
  formats and are never compared directly.
- A native entry that is a **symlink resolving to the canonical directory** is
  `synced`. Overlord MUST NOT replace it. Claude follows symlinked skill
  directories and deduplicates them, so this is a valid user-chosen layout.
- A **dangling symlink** is `invalid`.
- A top-level canonical definition symlink is `invalid`: the canonical source
  must physically live inside `.agents`. Relative symlinks within a skill are
  retained only when they resolve inside that skill tree.
- Mutations MUST refuse a symlinked `.agents` root or symlinked canonical parent
  directory so adoption cannot escape the selected scope.

### 9.2 States

<!-- markdownlint-disable MD013 -->

| State | Meaning |
| --- | --- |
| `synced` | Canonical source and native output agree. |
| `missing` | Canonical definition exists; native output is absent. |
| `unadopted` | A native definition exists with no canonical counterpart. |
| `conflict` | Both sides exist and differ, or two sources collide (sections 5.4, 8.2). |
| `external` | Configuration explicitly acknowledges another owner. |
| `invalid` | Malformed frontmatter, non-portable name, or dangling symlink. |

<!-- markdownlint-enable MD013 -->

Overlord is authoritative by default for persistent, loose user and project
skills and agents in the managed native locations of sections 8.1 and 8.2.
An `unadopted` entry remains unresolved until it is adopted, declared external,
or explicitly deleted. Compatibility surfaces inventoried only through
diagnostics, such as `.claude/commands/`, remain outside this state model. This
policy does not make unobserved built-in or organization-managed behavior an
error.

### 9.3 `status` and `check`

`overlord status` is an inventory. It MUST exit successfully when inspection
completed, even if attention is required. It reports all states, an adoption
summary, and suggested next actions.

`overlord check` is a strict assertion suitable for automation. It MUST fail for
`missing`, `unadopted`, `conflict`, or `invalid`. It MUST NOT fail for `synced`
or `external`.

A native output whose canonical source was deleted is indistinguishable from
any other native-only definition and is therefore `unadopted`. Overlord MUST
NOT infer ownership from matching content, generated comments, timestamps, or
paths. It may remove the definition only after an explicit `delete` resolution.

## 10. The `sync` walk

`overlord sync` is the primary command. It reconciles both directions in one
pass and resolves conflicts interactively.

```text
$ overlord sync

  ~/Projects/foo

  + copied  2 skills to .claude/           (only in .agents)

  ⚠ verify — differs

    .agents/skills/verify/SKILL.md
    .claude/skills/verify/SKILL.md
    │ + run `npm run build:staging` before starting the server
    │ - run `npm run build` before starting the server

    [a] keep .agents   [c] keep .claude   [d] full diff   [s] skip

  ? deploy — in .claude/ only, not managed by Overlord

    [y] adopt into .agents   [e] mark external   [x] delete   [s] skip
```

Unambiguous work happens without prompting: `missing` definitions are copied
out. `unadopted` and `conflict` require a decision. Overlord never automatically
removes or replaces an existing definition.

The first block reports work already completed; everything below it is still
pending. Adoption is a prompt, not a copy: section 10.4 can rename a definition
to satisfy the name rule for its kind, and can move rather than copy one out of
a Codex scan-only directory. Neither is a change Overlord may make unasked.

Adoption is not a separate migration mode. A first run on an existing machine is
the same walk with more items in it.

### 10.1 Rules

- Overlord MUST prompt only when standard input is a terminal. Otherwise it
  performs the unambiguous work, leaves decisions unresolved, and reports them.
- `--json` MUST NOT prompt. It performs the unambiguous work and returns
  outstanding decisions as `requiresDecision`.
- Skipping MUST be the default and MUST change nothing. A skipped conflict
  remains a conflict and `check` still fails on it.
- Overlord MUST NOT choose a destructive default.
- A resolution MUST also be expressible non-interactively, using the selector
  syntax in section 10.2:

  ```sh
  overlord sync --resolve verify=agents --resolve deploy=adopt
  ```

  This is the path an LLM uses: run `sync --json`, surface the diff to the user,
  obtain a decision, then apply it. Without it the bundled skill (section 16)
  stalls at the first conflict, which is exactly when an agent is most useful.

### 10.2 Resolution selectors

A decision is identified by kind, name, and scope. None of the three is unique on
its own: a skill and an agent may share a name, and the same name may be
outstanding in user and project scope.

```text
--resolve [<kind>:]<name>[@<scope>]=<side>
```

`<kind>` is `skill` or `agent`. `<scope>` is `user` or an absolute project path.
A bare `<name>` MUST be accepted when it matches exactly one outstanding
decision, so the ordinary single-project case stays short. When it matches more
than one, Overlord MUST fail with exit code 2 and print the qualified form of
every match rather than guessing.

Valid sides depend on what is being decided:

<!-- markdownlint-disable MD013 -->

| State | Side | Meaning |
| --- | --- | --- |
| `conflict` | `agents`, `claude`, `codex` | Keep that copy; replace the others. |
| `unadopted` | `adopt` | Install the native definition canonically; a scan-only skill is moved as described in section 10.4. |
| `unadopted` | `external` | Record it under `external` and leave it in place. |
| `unadopted` | `delete` | Back up and remove the native definition after explicit confirmation. |
| either | `skip` | Change nothing. Section 10.1 already makes this the default. |

<!-- markdownlint-enable MD013 -->

`codex` is a side only for the scan-only duplicate in section 8.2, the one case
where both copies of a skill are native. Cross-scope collisions have no side at
all; see section 5.4.

A selector naming a definition with no outstanding decision MUST be a usage
error, not a silent no-op — it usually means the state changed since the plan
was produced.

`--json` MUST carry the fully-qualified selector and the legal sides for every
outstanding decision, so an agent following section 16 never constructs a
selector by hand or guesses what it may offer. The formal shape is `decision` in
`docs/schemas/output.schema.json`.

### 10.3 Constraints

`sync` MUST NOT:

- Overwrite or delete an `external` definition.
- Resolve a `conflict` without an explicit decision.
- Remove an `unadopted` definition without an explicit `delete` decision,
  except for the verified move that completes an explicit scan-only adoption in
  section 10.4.
- Treat a matching generated comment, path, or current render as proof that it
  owns a native definition.

### 10.4 Adoption

Adopting a native definition into canonical source:

- For a skill, copies the complete directory and validates it. Files Overlord
  does not understand MUST be preserved unless validation proves them unsafe or
  invalid.
- For a skill adopted from a scan-only location (section 8.2), **moves** rather
  than copies: the original MUST be removed once the canonical copy is installed
  and verified, with a backup retained. Copying would leave the same name in both
  `.agents/skills/` and a Codex scan-only directory, which is a permanent
  `conflict` that no later `sync` could clear. If the user declines the removal,
  the definition MUST be recorded as `external` instead of adopted.
- For an agent, maps the native name, description, and instruction body into
  common fields and preserves native-only fields under the source target's
  overlay.
- Requires approval of a portable rename if the native name violates section 6
  for a skill or section 7.3 for an agent.

Where the same name is adopted from both targets, identical definitions are
deduplicated into one canonical definition and differing ones are a `conflict`.
Overlord MUST show the differences and MUST NOT guess which target is newer or
better.

Before writing, Overlord MUST stage canonical files outside the live source,
validate them, render all available targets, and verify that supported fields
survive a semantic round trip. It MUST back up native originals outside the
Git-tracked canonical source. A failure before installation MUST leave live
state unchanged. A failure during installation MUST stop, preserve backups, and
report exactly which operations completed.

## 11. External definitions

Configuration can acknowledge definitions that are visible in a native location
but owned elsewhere:

```yaml
external:
  - kind: skill
    name: company-review
    reason: Installed by company policy
```

Each entry MUST identify kind and name. Its scope is the scope of the containing
configuration file. `target` is optional for skills, which are shared by both
tools, and required for agents. A reason SHOULD be provided. External
declarations suppress the unadopted error but do not allow Overlord to modify
the artifact. For a skill, an omitted `target` applies to both targets; a
supplied `target` acknowledges only that target's native copy.

Where a target reports built-in, plugin, organization, or reserved definitions,
Overlord SHOULD display them separately from filesystem-managed coverage. It
MUST distinguish "not managed" from "not observable."

Version 0.1 has no `reserved` state. Neither target exposes a machine-readable
list of its built-in definitions, so the state could not be determined reliably.
The concrete cases are handled by rule instead: Codex built-ins are skipped via
`.system` (section 8.2), and Claude's built-ins and plugin skills do not appear
in the directories Overlord scans.

An interactive `external` resolution adds the entry to the definition's scope
`overlord.yaml`. Removing or editing an exception is an ordinary configuration
edit followed by `status` or `check`; version 0.1 has no separate `external`
command family.

## 12. Explicit operating model

Version 0.1 operates on one explicitly selected scope per invocation. It does
not keep a project registry, scan descendant directories for projects, watch
the filesystem, install a service, or run synchronization in the background.

A user runs `sync` after changing canonical definitions. A CI job or agent may
invoke the same command explicitly, but its invocation is visible and uses the
same dry-run and decision rules as a human invocation. Future background
automation can be added without changing the canonical formats or the stateless
comparison model.

## 13. CLI contract

Overlord is currently distributed as public source from
`https://github.com/geekforbrains/overlord` and implemented in TypeScript on
Node.js. The supported floor is **Node 22**. Node is an explicit Overlord
dependency: both target CLIs also offer native installation paths, so Overlord
MUST detect and explain a missing or unsupported Node runtime rather than assume
one is present.

The npm package named `overlord` is unrelated to this project. There is no
current `npx overlord` command for this project. Once a distinct npm name is
reserved, an ephemeral invocation may be offered for a first look. An
installed, pinned CLI SHOULD be used for routine and agent-driven work so
invocation does not silently fetch new package code. Documentation and quick
starts MUST NOT publish an npm installation command until that package name is
owned, and MUST reflect the pinned-versus-ephemeral distinction afterward.

The initial command families are:

```text
overlord init
overlord status
overlord check
overlord sync
```

`import`, `diff`, and `discard-native-changes` from draft 0.1 no longer exist as
separate commands. Adoption, diff display, and native-change resolution are all
steps within the `sync` walk (section 10).

`init` creates the canonical directories and a minimal `overlord.yaml` for the
selected scope. `init --global` also installs the bundled skill described in
section 16. Project initialization MUST NOT install a second copy of that skill;
it reports how to initialize the user scope if the global copy is absent. `init`
MUST NOT overwrite existing configuration or definitions without explicit
confirmation. Skills and agents are otherwise created by writing their
canonical files directly; version 0.1 has no `new` command family.

All mutating commands MUST support `--dry-run --json`. They MUST identify all
files they would read, write, replace, or remove. Interactive confirmation is
required for destructive resolution in human mode. JSON mode MUST never prompt.

Commands SHOULD support `--global` and `--project <path>` where the operation
makes sense. Supplying both MUST fail with a specific error.

`--strict` promotes the unrecognized-overlay-field warning of section 7.2 to a
validation failure. It MUST be accepted by `check`, `status`, and `sync`, so that
a CI job and the run that has to satisfy it can apply the same rule. It changes
severity only; it never changes what Overlord writes.

`status`, `check`, and `sync --dry-run` MUST validate configuration, native
paths, target availability, and permissions before reporting a healthy scope.
Version 0.1 has no separate diagnostics command. Where a target can report its
own view, Overlord SHOULD prefer that over filesystem assumptions; `codex debug
prompt-input` enumerates every skill Codex sees, with absolute paths, without a
model call.

### 13.1 Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Completed successfully; `status` may still report attention required. |
| 1 | A strict assertion completed with attention required. |
| 2 | Usage error: bad arguments, invalid flag combination, unreadable config. |
| 3 | Internal error. |

`status` returns 0 whenever inspection completed. `check` returns 1 when any
failing state is present. Consequently, JSON `status: attention-required`
usually maps to exit 1 but maps to exit 0 for the inventory-only `status`
command. JSON status describes the result; it is not a universal encoding of
the process exit code.

## 14. Machine-readable and LLM-friendly output

`--json` is a first-class public API:

- Standard output MUST contain exactly one JSON document and no prose. This
  holds on error paths: a failing command MUST emit a single document with an
  `error` object rather than partial or absent JSON.
- Diagnostics and progress MUST go to standard error.
- Color and interactive prompts MUST be disabled.
- The document MUST contain a stable `schemaVersion`.
- State and severity values MUST be documented enums matching section 9.2.
- Paths MUST be absolute in write plans and unambiguous in inventory output.
- Recommendations MUST be structured actions with argument arrays, not shell
  command strings.
- A choice that needs judgment MUST return `requiresDecision`; Overlord MUST NOT
  choose a destructive default.

The formal schema is `docs/schemas/output.schema.json`. It is part of the public
contract: implementations MUST validate their own output against it in tests,
and consumers MAY rely on it. An illustrative response is:

```json
{
  "schemaVersion": 1,
  "command": "status",
  "status": "attention-required",
  "scope": {
    "type": "project",
    "path": "/Users/example/Projects/foo",
    "canonical": "/Users/example/Projects/foo/.agents",
    "resolvedBy": "nearest-ancestor",
    "evidence": "/Users/example/Projects/foo/.agents"
  },
  "definitions": [
    {
      "kind": "skill",
      "name": "verify",
      "scope": "project",
      "project": "/Users/example/Projects/foo",
      "state": "conflict",
      "canonical": "/Users/example/Projects/foo/.agents/skills/verify",
      "evidence": "content differs at SKILL.md",
      "decision": {
        "selector": "skill:verify@/Users/example/Projects/foo",
        "options": ["agents", "claude", "skip"]
      }
    }
  ],
  "actions": [
    {
      "id": "resolve-skill-verify",
      "description": "Skill 'verify' differs between .agents and .claude",
      "argv": [
        "overlord",
        "sync",
        "--resolve",
        "skill:verify@/Users/example/Projects/foo=agents"
      ],
      "mutates": true,
      "requiresConfirmation": true,
      "requiresDecision": true,
      "scope": "project",
      "writes": ["/Users/example/Projects/foo/.claude/skills/verify"]
    }
  ]
}
```

Status and check output MUST include:

- The selected scope and how it was resolved.
- Target availability and gaps in coverage.
- Per-definition state and the evidence for it.
- An adoption summary, so migration shows progress rather than a wall of errors.
- Exact proposed actions and whether they mutate state.

## 15. Concurrency and safety

Overlord keeps no persistent ownership state. Temporary staging, locks, and
recoverable backups MUST live outside both the Git-tracked canonical source and
the target directories. Their exact paths MUST be reported when relevant.

Overlord MUST:

- Acquire a per-scope lock before any mutation.
- Stage output and use atomic replacement where the operating system permits.
- Validate all canonical definitions in a scope before rendering output for that
  scope. This guarantee cannot extend to Codex skills, which read canonical
  source directly and are therefore live the moment a file is saved.
- Preserve executable bits and relevant file permissions for skill files.
- Refuse path traversal, absolute paths in archive-like adoptions, and writes
  that escape the resolved native directory.
- Never place credentials or machine secrets into canonical source.
- Never run Git commands that mutate a repository automatically.
- Show and confirm any `.gitignore` edit made during `init` in an existing
  repository.
- Redact secrets from diagnostics and logs.
- Retain recoverable backups for adoption moves, explicit deletion, and
  destructive conflict resolution.
- Stop on a failed mutation and report which planned operations completed and
  where backups are stored. A later `status` or `check` determines current state
  directly from the filesystem.

Read-only `status` and `check` do not require the mutation lock.

## 16. Bundled `overlord` skill

`overlord init` installs a normal portable skill at:

```text
~/.agents/skills/overlord/SKILL.md
```

It is part of the canonical source, so it can be committed and materialized like
every other skill. Initialization MUST NOT overwrite a modified bundled skill
without showing a diff and receiving explicit consent.

The skill description should trigger when a user asks to create, modify, adopt,
delete, diagnose, or synchronize a skill or subagent. Its workflow is:

1. Run `overlord status --json` to determine scope, paths, and current state.
2. Author or edit only the canonical definition under `.agents`.
3. Run `overlord sync --dry-run --json`.
4. For any `requiresDecision`, present the diff and obtain a human decision,
   then apply it with `overlord sync --resolve <name>=<side>`.
5. Run `overlord sync` and finish with `overlord check`.

The skill SHOULD cooperate with target-native skill-authoring guidance for
content quality while overriding only storage and materialization workflow. It
MUST warn agents not to edit generated native files directly. A recommended
action is information, not permission.

Not every delegated subagent can load skills. The CLI contract and generated
file notices therefore remain the enforcement mechanism; the bundled skill is
guidance, not the sole safety boundary.

## 17. Expected operating behavior

Three things will happen often enough that the design must absorb them rather
than treat them as faults.

**Target tools write skills on their own.** Claude Code's `/run-skill-generator`
writes `.claude/skills/run-<name>/`, and `/verify` records
`.claude/skills/verify/SKILL.md` and edits it when a run goes wrong. These appear
as `unadopted`, or as `conflict` once a canonical copy exists. Surfacing them is
correct; resolving one must cost a single keystroke in the `sync` walk.

**Canonical source is live for Codex.** Saving a half-finished `SKILL.md` under
`.agents/skills/` makes it visible to Codex immediately. This is inherent to
building on the standard location and is no worse than editing a native
directory by hand, but it means `sync` is not a gate for Codex skills.

**Shared repositories may end up with two copies.** In a project whose team
already commits `.claude/skills/`, adoption produces an identical copy under
`.agents/skills/`. Both are `synced` and nothing is broken, but the repository
now contains the same skill twice, and a teammate not using Overlord will keep
editing the `.claude/` copy — which surfaces as a `conflict` on the next sync.

Overlord MUST NOT restructure a repository to resolve this. Whether to commit
`.agents/`, gitignore it, or leave the project unmanaged is the user's decision,
and `status` SHOULD note when an adopted project has its native definitions under
version control so the choice is visible before the first commit.

## 18. Version 0.1 acceptance criteria

Version 0.1 is complete when all of the following are demonstrated on supported
platforms:

1. One standard skill can be authored globally under `.agents/skills/`, appear in
   Codex with no materialization step, be copied to Claude, be modified
   canonically, and be reconciled without symlinks.
2. One canonical agent renders to valid Claude Markdown and Codex TOML with
   target-specific settings preserved.
3. Rendering is byte-identical across two machines and two runs, and unchanged
   output is not rewritten.
4. A clone of the canonical source onto a clean machine materializes missing
   output on its first `sync` without any adoption step, after which `check`
   reports every definition as `synced`. On a machine running only one available
   target, the other target degrades to a warning rather than a wall of `missing`
   output.
5. User and project scopes resolve predictably, and cross-scope name collisions
   are reported rather than silently resolved by precedence.
6. A same-named skill in `.agents/skills/` and `~/.codex/skills/` is reported as
   a conflict.
7. `.system` is skipped; Claude built-ins and plugin skills never appear as
   unadopted.
8. The `sync` walk handles copy, adopt, conflict, external, delete, and skip;
   only missing output is handled without a decision; `--resolve` produces the
   same result non-interactively.
9. A first run on a machine with pre-existing native definitions completes
   through the walk without hand-written configuration, and `status` reports
   adoption progress.
10. Explicit external definitions remain untouched and do not fail `check`.
11. Removing a canonical definition leaves existing native output as
    `unadopted`; Overlord does not remove it until an explicit `delete`
    resolution is confirmed.
12. Each command operates on one scope resolved from `--global`, `--project`,
    the nearest `.agents` ancestor, or the current Git worktree. It does not
    scan descendant projects or start background work.
13. Concurrent mutations of one scope are serialized; each completed file
    replacement is atomic, and a failure reports every operation that completed.
14. A dangling symlink is reported `invalid`; a symlink resolving to canonical is
    reported `synced` and left in place.
15. Adopting a skill from a Codex scan-only directory removes the original,
    and a subsequent `check` passes rather than reporting a permanent duplicate.
16. A serializer or adapter change that changes rendered bytes is reported as a
    conflict and is not automatically migrated or overwritten.
17. JSON output is schema-tested, contains structured actions, never prompts, and
    emits one document on error paths. Exit codes match section 13.1.
18. The bundled `overlord` skill is installed canonically and usable by both
    targets.
19. Documentation clearly identifies native behavior that Overlord cannot observe
    or own.

## 19. Release limitations and deferred decisions

The local implementation exists, but these items remain release limitations or
deferred product decisions:

- npm package naming and publication remain deferred. The GitHub repository and
  local executable names are settled as `overlord`; `package.json` remains
  private until a distinct registry name is owned.
- Supported platforms. Version 0.1 assumes macOS and Linux; Windows is
  unaddressed and would change symlink handling (section 9.1), permission
  preservation, and atomic replacement behavior.
- Exact backup location and retention defaults.
- Supported Claude Code and Codex CLI version ranges, and the known-field lists
  used for typo suggestions in section 7.2.
- Whether a later release adds project discovery or background synchronization.
  The non-normative [auto-sync design draft](auto-sync-design.md) records the
  current product discussion without changing the version 0.1 contract.
- Whether a later release adds an explicit renderer migration workflow.
- Whether `.claude/commands/` conversion is added in a later version.

## 20. Verification record

The adapter contract must be revalidated against current target versions before
release. This record distinguishes direct installation checks from behavior
grounded only in provider documentation.

### 20.1 Verified on a real installation

Checked 2026-07-30 against Codex CLI 0.146.0 and Claude Code 2.1.220, using an
isolated temporary project and home/configuration directories:

- A built Overlord synchronized one canonical skill and one canonical agent to
  `.claude/skills`, `.claude/agents`, and `.codex/agents`; the final
  `overlord check --json` reported both definitions `synced` with no pending
  actions or diagnostics.
- Claude loaded and invoked both the generated project skill and the generated
  project subagent in bounded, no-tools, one-turn CLI runs.
- `codex debug prompt-input` listed the canonical project skill from its exact
  `.agents/skills/<name>/SKILL.md` path without making a model request.
- Codex reads skills from all four of `~/.agents/skills`, `~/.codex/skills`,
  `<project>/.agents/skills`, and `<project>/.codex/skills`.
- Codex does not deduplicate same-named skills across those locations; both are
  presented to the model under one name.
- Codex reports an absolute source path for every skill it loads.
- Codex built-in skills are real directories at `~/.codex/skills/.system/`.
- Codex plugin skills are namespaced `plugin:skill` and live under
  `~/.codex/plugins/cache/`, outside any scanned location.
- Claude bundled skills and plugin skills do not appear in `~/.claude/skills` or
  `~/.claude/agents`; only user-authored definitions are present there.
- Project-level skills are live in Codex purely by virtue of the working
  directory, with no installation step.

### 20.2 Verified from primary documentation only

Not reproduced through a model-backed Codex subagent turn. The installed
zero-model debug and app-server interfaces expose skill discovery but no custom
agent listing method, so the generated Codex agent is validated against the
documented path and file contract without claiming runtime invocation.

- Codex custom agents: TOML at `${CODEX_HOME:-~/.codex}/agents/` and
  `<project>/.codex/agents/`, with `name`, `description`, and
  `developer_instructions`, plus arbitrary `config.toml` keys.
- Claude documents subagent names using lowercase letters and hyphens; it does
  not promise digit support. This is why section 7.3 is stricter than the Agent
  Skills name rule.
- Claude subagent frontmatter field set and its per-release growth.
- Claude skill precedence (enterprise, personal, project) and subagent
  precedence (managed, session, project, user, plugin).

These MUST be re-checked before the first npm publication.

### 20.3 Primary references

- [OpenAI Codex: Multi-agent and custom agents](https://developers.openai.com/codex/multi-agent/)
- [OpenAI Codex: Skills](https://developers.openai.com/codex/skills/)
- [Agent Skills specification](https://agentskills.io/specification)
- [Claude Code: Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code: Extend Claude with skills](https://code.claude.com/docs/en/skills)
- [Claude Code: Explore the `.claude` directory](https://code.claude.com/docs/en/claude-directory)
- [TOML 1.0 specification](https://toml.io/en/v1.0.0)
