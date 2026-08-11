# Overlord v0.2 specification

Status: normative for Overlord 0.2.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY describe requirements on conforming implementations.

## 1. Purpose

Overlord keeps filesystem-backed Claude Code and Codex skills and custom agents synchronized through one durable `.agents` source in the user scope and in every discovered project. Intentional edits SHOULD target `.agents`, but provider-native files are tracked endpoints because a provider may create, modify, or delete them while helping the user. After every successful reconciliation, `.agents` contains the resulting canonical definition for that scope.

Every status, check, and sync invocation operates on the same fleet regardless of the process working directory: the user scope plus independent project scopes found below configured discovery roots.

Overlord is a filesystem reconciler and maintains Git history for the user source at `~/.agents`. It is not an agent runtime, provider launcher, project registry, or source-control manager for project repositories.

## 2. Fleet configuration

The only Overlord configuration file is `~/.agents/overlord/overlord.yaml`, where `~` means the injected or operating-system home directory.

The configuration has this shape:

```yaml
roots:
  - ~/Projects
  - /absolute/path/to/another-parent
```

`roots` MUST be an array; unknown keys MUST make the configuration invalid. The configuration has no version field. Breaking configuration changes MUST be documented when they are introduced.

Each root MUST be an absolute path or start with `~/`; a `~/` root MUST be expanded against the home directory, every result MUST be normalized, and duplicate normalized paths MUST be removed while preserving first occurrence order.

A missing configuration file inside an initialized user repository MUST behave as an empty `roots` list. This does not remove the command-initialization precondition in section 10.

The configuration is user-level fleet configuration only; project-local configuration files are not read.

## 3. Scope discovery

The user scope MUST always be first and MUST use the resolved absolute home directory as its scope path and `<home>/.agents` as its canonical path.

Each configured root is a discovery boundary and project candidate. Overlord MUST inspect the root itself and its descendants recursively.

A configured root or descendant is a project scope when at least one of these artifact paths exists:

- `.agents/skills` for canonical skills read directly by Codex
- `.agents/overlord/agents`
- `.claude/skills`
- `.claude/agents`
- `.codex/agents` for Codex custom agents

A physical directory marks a scope only when it contains at least one entry. A symlink or non-directory in an artifact path also marks a scope, and MUST NOT be traversed or followed; discovery records the scope so the unsupported artifact root is reported as an error rather than silently omitting the project. Such a scope is inventoried, produces error diagnostics, and is blocked from mutation under section 13.

The project scope path is the matching root or descendant and its canonical path is `<project>/.agents`; definitions found in it MUST remain in that scope and MUST NOT be hoisted to a configured root, ancestor, or sibling.

Canonical-only and provider-native-only projects MUST both be discoverable. Codex skills are discovered at `.agents/skills`, and Codex custom agents are discovered at `.codex/agents`; Git markers, `.codex/skills`, and `.claude/commands` alone MUST NOT create a scope.

Nested and sibling project scopes are independent; discovery MUST continue below a found project so an intentional nested scope can also be found.

Discovery MUST NOT traverse `.agents`, `.claude`, `.codex`, `.git`, `node_modules`, `vendor`, `dist`, `build`, `.cache`, or `.venv` directories.

Discovery MUST NOT follow directory symlinks; configured roots MUST be physical directories; real paths MUST be used to deduplicate overlapping roots and aliases.

When configured roots overlap, each physical directory MUST be scanned once. A configured root becomes a project only when it contains supported definitions, never merely because an outer root contains it.

Project scopes MUST be emitted once in lexical path order after the user scope.

A missing, non-directory, symlinked, or unreadable discovery root and an unreadable traversed directory MUST produce an error diagnostic, MUST make fleet status `attention-required`, and MUST NOT prevent readable roots or the user scope from being processed.

## 4. Scope isolation and locations

Every scope is reconciled independently, and the same definition name MAY have different content in user and project scopes without creating a conflict.

A failure, lock, invalid definition, or conflict in one project MUST NOT block synchronization of sibling scopes.

Within one scope, a definition is identified by kind and name; structured records and actions MUST also carry the absolute `scopePath` so repeated names remain unambiguous across the fleet.

Each scope MUST use one physical layout: `.agents` contains the durable canonical definition after synchronization, while managed files below `.claude` and `.codex` are tracked provider endpoints. Managed artifact roots, definition directories, definition files, and skill payload entries MUST NOT be symlinks. A provider endpoint MAY supply an unambiguous addition, edit, or deletion; Overlord MUST incorporate it into that scope's canonical source before updating the other endpoints.

The canonical locations are:

```text
<scope>/.agents/skills/<name>/SKILL.md
<scope>/.agents/overlord/agents/<name>.md
```

Project-native locations are:

```text
<project>/.claude/skills/<name>/
<project>/.claude/agents/**/*.md
<project>/.codex/agents/<name>.toml
```

User-native locations default to `~/.claude/skills`, `~/.claude/agents`, and `~/.codex/agents`.

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` MAY override the corresponding user-native root; an absolute value is used directly and a relative value is resolved against home, never against the process working directory.

Provider override paths MUST NOT physically overlap canonical or native artifact roots in the user scope or any discovered project scope. Overlap through symlinks, filesystem aliases, or case-equivalent paths MUST produce error diagnostics and MUST block mutation in every affected scope.

Codex reads canonical skills directly from `<scope>/.agents/skills`, so Overlord MUST NOT generate or inventory a `.codex/skills` output.

Claude skills MUST be materialized as physical directories under `.claude/skills`; canonical agents MUST be deterministically rendered as physical files in both enabled native agent locations.

The user source at `~/.agents` MUST be a dedicated Git repository initialized and maintained by Overlord. Its `.git` entry MUST be a physical directory, and the repository's physical work-tree top level MUST be the user canonical root. A Git worktree file, symlinked `.git`, or repository configured with another work tree MUST be rejected. A project source at `<project>/.agents` belongs to its containing project; Overlord MUST NOT inspect or otherwise invoke Git in that project repository.

## 5. Canonical skill format

A canonical skill is a physical directory named for the skill and containing `SKILL.md` with YAML frontmatter.

The `name` field MUST equal the directory name, MUST contain 1–64 lowercase ASCII letters, digits, or single hyphens, and MUST have no leading, trailing, or consecutive hyphen.

The `description` field MUST be a non-empty string no longer than 1,024 characters.

The synchronized skill value is its file paths, file bytes, and executable bits. Empty directories, directory permission bits, and non-executable file permission differences MUST NOT be treated as changes because the user Git repository cannot preserve them. Materialization MAY copy those incidental properties, but reconciliation and history MUST use the Git-representable value. A `.git` entry or case variant anywhere inside a skill MUST be invalid because the owning source repository would otherwise record nested repository metadata instead of the skill's ordinary files.

Every symlink inside a canonical or provider-native skill, including a top-level skill symlink and an internal payload symlink, MUST be invalid.

Operating-system metadata files `.DS_Store`, `Desktop.ini`, `Thumbs.db`, `ehthumbs.db`, and names beginning `._` MAY be ignored.

## 6. Canonical agent format

A canonical agent is Markdown with YAML frontmatter and this common shape:

```markdown
---
version: 1
name: reviewer
description: Reviews changes.
targets:
  claude: {}
  codex: {}
---

Review the requested change.
```

`version` MUST equal `1`; `name` MUST equal the file stem and contain 1–64 lowercase ASCII letters or single hyphens; `description` and the Markdown instruction body MUST be non-empty.

When present, `targets` MUST be a mapping whose only keys are `claude` and `codex`; omitted targets default to empty mappings, and `false` disables an output.

Provider-specific fields MUST remain under their target mapping; fields reserved for the portable name, description, or instruction body MUST NOT be supplied as overlays.

Unknown overlay fields SHOULD be preserved and reported as warnings so provider additions do not become lossy.

Claude rendering MUST write portable name and description, then deterministic Claude overlay fields, followed by the instruction body.

Codex rendering MUST write deterministic TOML containing name, description, Codex overlay fields, and the body as `developer_instructions`, with an Overlord-generated notice.

Rendering MUST be stable: identical canonical bytes and supported metadata MUST produce identical native output bytes.

## 7. Inventory and states

Overlord MUST inventory canonical and provider-native files on every run without invoking provider executables or changing behavior based on executable discovery.

Claude agent inventory is recursive below `.claude/agents`; Codex agent inventory includes immediate `.toml` files below `.codex/agents`; skill inventory includes immediate child directories below canonical and Claude skill roots. `.codex/skills` is outside inventory because Codex reads `.agents/skills` directly.

Overlord MUST retain a machine-local record of the last successfully synchronized content for every definition and endpoint. This ledger MUST live below `~/.agents/.git`, MUST be keyed by physical scope path and provider endpoint, and MUST NOT add state files to a project repository. The ledger is private synchronization metadata, not canonical skill or agent content. Its file layout and JSON representation are implementation details, not a public schema, version, or migration mechanism.

Every definition record MUST have one aggregate state with precedence `invalid`, `conflict`, `changed`, `missing`, then `synced`.

- `synced` means every required endpoint matches canonical content, or the endpoint reads canonical content directly.
- `missing` means valid content exists in a scope but an endpoint with no deletion receipt is absent and must be materialized.
- `changed` means one endpoint contains an unambiguous addition, edit, or tracked deletion relative to the last successful sync.
- `conflict` means multiple sides changed incompatibly from their common baseline, modification competes with deletion, a same-target duplicate is ambiguous, or output exists for a disabled agent target.
- `invalid` means canonical or native syntax, names, paths, overlays, entry types, or symlinks violate this specification.

Fleet status MUST be `attention-required` when any definition is missing, changed, conflicting, or invalid, or when any error diagnostic exists; otherwise it MUST be `ok`.

An invalid record attached to canonical content MUST block all mutations in that scope after preflight, while an invalid provider-only record MUST remain untouched without blocking unrelated valid definitions in that scope.

Conflicts MUST remain untouched and MUST NOT block safe work for other definitions in the same scope. Isolation is per output, not per definition: a conflicting output MUST NOT prevent another target of the same definition from being materialized when that target is otherwise safe.

## 8. Deterministic reconciliation

`sync` MUST converge every safe definition using its last-synchronized baseline. It MUST rescan before planning, after acquiring the scope lock, after incorporating a provider change, and before final reporting.

Within one scope, reconciliation MUST follow these rules:

- When only canonical content changed from baseline, canonical wins and every enabled provider endpoint is updated.
- When only one provider endpoint changed from baseline, that change is converted into canonical form and then propagated to the other enabled endpoints.
- When a valid definition is new on exactly one side, it is created in canonical and every enabled endpoint for that scope.
- When multiple sides independently reach identical valid content, Overlord MAY accept that content without conflict.
- When multiple sides change incompatibly, Overlord MUST report a conflict and MUST NOT choose a winner.
- A conflict in one definition MUST NOT block unrelated safe work in the same scope.

When no baseline exists, content present on exactly one side is a new definition, identical content on multiple sides establishes the initial baseline, and differing content on multiple sides is a conflict. Overlord MUST NOT use modification times to choose a winner.

For skills, the complete Git-representable file tree is the synchronized value. A Claude-created skill MUST be copied into the same scope's `.agents/skills`; a canonical skill MUST be materialized for Claude; Codex reads the canonical tree directly.

For agents, a provider-created or provider-edited definition MUST be converted to canonical Markdown while retaining the corresponding provider overlay, then rendered to the other enabled target. Independently changed native agents with incompatible common fields MUST conflict.

The same kind and name in different scopes are unrelated. No addition or edit MAY be hoisted from a project into the user scope or copied between projects.

The operation MUST be idempotent: a fully synchronized second run MUST perform no filesystem or Git mutations.

## 9. Tracked deletion

Deletion is a synchronized change only when the ledger proves that the definition previously existed at that endpoint.

When exactly one side deletes a previously synchronized definition and no other side changed, `sync` MUST delete the definition's canonical and generated counterparts in that scope. A user-scope deletion MUST be included in the automatic `~/.agents` commit. A project deletion MUST NOT cause Overlord to commit the project repository.

Deletion competing with modification or with a different deletion state MUST be reported as a conflict and left untouched.

Absence without a last-synchronized receipt, including a missing output in a newly discovered scope, MUST NOT be inferred as deletion. Existing valid content MUST be materialized to the absent endpoint.

## 10. Commands

The command family is:

```text
overlord init
overlord status
overlord check
overlord sync
```

`init` MUST create the user canonical root when needed and create or validate a dedicated physical Git repository rooted exactly there. It MUST reject unsupported `.git` files or symlinks and repositories whose work-tree top level is elsewhere. It MUST create a minimal `roots: []` configuration when absent, install the bundled Overlord skill when absent, commit the initial managed canonical state with the fixed subject `overlord: initialize`, and initialize the private synchronization ledger below `.git`. A repeated no-op `init` MUST NOT create another commit.

`status`, `check`, and `sync` MUST require an existing dedicated user repository. `init` is the normal way to establish it, but a valid manually initialized repository, including an unborn repository, is accepted without a hidden initialization marker. Before fleet discovery the commands MUST validate the repository without creating the canonical root, `.git`, a commit, or ledger state. An absent or invalid repository MUST fail as a top-level permission error.

`status` MUST discover and inspect the complete fleet without mutation and MUST report attention while still exiting successfully after a completed inspection. It MUST NOT stage or commit files or create or update ledger state.

`check` MUST perform the same read-only fleet inspection and MUST fail its assertion when attention is required.

`sync` MUST discover the complete fleet, reconcile each scope sequentially, continue after a scope-local failure, and report the final inventory plus completed and still-planned actions.

For the user scope, `sync` MUST apply every safe canonical write and deletion for the invocation before provider propagation, stage the changed fleet configuration plus the Overlord-managed canonical paths selected by safe reconciliation, and create at most one commit with the fixed subject `overlord: synchronize`. It MUST then report the commit SHA, sorted originating endpoints when applicable, and committed canonical files using fixed program output. An LLM MUST NOT compose the message or select staged files. Other staged and working-tree changes MUST remain excluded and preserved. A clean/no-op sync MUST NOT create a commit, and Overlord MUST NOT push.

User provider propagation MUST begin only after that commit succeeds or Git establishes that the selected canonical paths are already clean. If the user commit fails, `sync` MUST stop before distributing those uncommitted canonical changes or advancing their ledger receipts; the canonical working-tree changes MUST remain visible for diagnosis and retry. Project canonical changes MUST be reconciled without invoking Git in the project repository, regardless of whether a project repository exists.

The only operational output option is `--json`; `--help` and `--version` are informational, and a command is required.

Human output MUST identify each scope and group definitions by absolute scope path.

## 11. Exit codes

| Code | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | The command completed successfully; `status` may still report attention.                     |
| `1`  | `check` or `sync` completed with attention required.                                         |
| `2`  | Usage, configuration, lock, or permission error prevented the requested top-level operation. |
| `3`  | An unexpected internal error prevented the requested top-level operation.                    |

Scope-local synchronization failures SHOULD become scoped error diagnostics so healthy siblings can continue; they yield attention rather than a top-level error document.

## 12. JSON output schema v2

`--json` MUST emit exactly one JSON document to standard output on success or failure and MUST conform to `docs/schemas/output.schema.json` with `schemaVersion: 2`.

A successful or attention-required document MUST contain `command`, `status`, ordered `scopes`, flattened `definitions`, fleet `summary`, `actions`, and `diagnostics`; timing and Overlord version MAY also appear.

Each scope MUST contain `type`, absolute `path`, and absolute `canonical`; a discovered project MUST also identify its `discoveryRoot`.

Each definition and action MUST contain `scope`, absolute `scopePath`, and absolute artifact paths where applicable.

Definitions MUST expose canonical path or `null`, target outputs, aggregate state, and optional evidence or conflicting paths.

Actions MUST distinguish `planned` from `completed` work and MUST identify reads, writes, removals, and Git commit metadata when applicable.

An error document MUST contain `status: error` and a typed error object; it MAY include actions completed before the failure and MUST omit the normal fleet payload when it could not be produced safely.

## 13. Mutation safety

Each mutating scope MUST use a per-scope lock derived from its physical path; stale lock recovery MUST be conservative, and independent scopes MAY proceed when one lock is held.

Every mutating scope MUST be inventoried before locking and again while locked so pre-lock observations never authorize stale writes.

File writes, replacements, and removals MUST refuse to act on observations that became stale after inventory.

A single file MUST be published atomically, so a partially written file is never observable at its destination. A directory copy is validated and staged first, but its entries are published individually into the destination, so publication of a skill tree as a whole is not atomic. A failure partway through MUST leave the partial tree in place rather than deleting entries it did not create, and MUST report the created paths as a completed action so the incomplete output is recoverable and visible. Version 0.2 does not guarantee that a provider never observes a partially materialized skill directory.

Before writing or removing, Overlord MUST verify that the destination remains inside the scope or configured user-native boundary and MUST refuse traversal through symlinked parent directories.

Discovery and inventory MUST NOT follow symlinked artifact roots or their parent control directories. Any symlink used as a managed artifact root, definition, definition file, or skill payload entry MUST be invalid and MUST be preserved without incorporation, materialization through it, or automatic removal.

Completed actions and Git commits MUST remain reportable if a later step fails.

## 14. Limitations

Version 0.2 manages only filesystem-backed skills and custom agents in the documented locations.

Built-in, organization-managed, plugin-provided, marketplace, and session-only definitions are outside inventory.

Claude commands, MCP settings, rules, hooks, `CLAUDE.md`, and `AGENTS.md` are not synchronized.

Overlord runs Git only for its user source at `~/.agents`. It MUST NOT commit generated provider files, alter project ignore rules, inspect or otherwise invoke Git in project repositories, push the user repository, or guarantee that an already running provider session reloads changed artifacts.

The implementation targets macOS and Linux with Node.js 22 or newer; Windows path semantics are not part of this version's contract.

## 15. Acceptance criteria

1. Running the same command from unrelated working directories discovers the same configured fleet and produces the same ordered scope set for unchanged filesystem state.
1. User definitions synchronize to user-native locations, and every discovered project's definitions synchronize only within that project.
1. Recursive discovery considers each configured root and its descendants, finds canonical-only and provider-native-only projects, preserves nested scope isolation, ignores pruned trees, never traverses a symlinked directory, still records a scope whose artifact root is a symlink so it is reported rather than omitted, and reports inaccessible roots without stopping healthy scopes.
1. A valid canonical skill materializes as a physical Claude directory while Codex reads canonical source directly, and a valid canonical agent deterministically renders as a physical file for each enabled target.
1. A single-sided canonical or provider addition or edit is incorporated into canonical and propagated within that scope, while incompatible concurrent changes remain untouched conflicts.
1. Invalid canonical-backed state blocks only its scope, while conflicts and provider-only invalid state do not block unrelated safe work.
1. A tracked single-sided deletion propagates within its scope, modification-versus-deletion conflicts remain untouched, and an untracked absence is materialized rather than treated as deletion.
1. User and project definitions with the same name remain independent and are distinguishable by absolute `scopePath` in human and JSON reports.
1. `init` creates or validates `~/.agents` as Overlord's only dedicated Git repository and records managed source in an initial fixed-message commit; a missing user repository makes inspection fail without mutation, user-source changes are committed once before provider propagation, and project repositories receive no Git operations.
1. `status`, `check`, `sync`, and `init` obey their documented exit behavior, and JSON output validates against schema version 2.
1. Concurrent mutation of one scope is serialized, sibling scope failures are isolated, every file write is atomic, an interrupted skill copy leaves a reported partial tree rather than a corrupted or silently discarded one, and every symlink in a managed path is refused.
