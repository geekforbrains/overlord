# Overlord v0.2 specification

Status: normative for Overlord 0.2.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY describe requirements on conforming implementations.

## 1. Purpose

Overlord keeps filesystem-backed Claude Code and Codex skills and custom agents synchronized from one canonical `.agents` format at user level and in every discovered project. Canonical `.agents` definitions are the only editable source; managed provider-native files are generated outputs.

Every status, check, and sync invocation operates on the same fleet regardless of the process working directory: the user scope plus independent project scopes found below configured discovery roots.

Overlord is a filesystem reconciler, not an agent runtime, provider launcher, project registry, or source-control tool.

## 2. Fleet configuration

The only Overlord configuration file is `~/.agents/overlord/overlord.yaml`, where `~` means the injected or operating-system home directory.

The configuration schema version is 2 and has this shape:

```yaml
version: 2
roots:
  - ~/Projects
  - /absolute/path/to/another-parent
```

`version` MUST equal `2`; `roots` MAY be omitted and then means an empty list; unknown keys MUST make the configuration invalid.

Version 1 per-scope configuration is not compatible with the fleet model and MUST be rejected instead of reinterpreted; users upgrading from 0.1 MUST replace legacy `external` entries with version 2 discovery roots.

Each root MUST be an absolute path or start with `~/`; a `~/` root MUST be expanded against the home directory, every result MUST be normalized, and duplicate normalized paths MUST be removed while preserving first occurrence order.

A missing configuration file MUST behave as `version: 2` with no roots, so user-level synchronization remains available before configuration.

The configuration is user-level fleet configuration only; project-local configuration files are not read.

## 3. Scope discovery

The user scope MUST always be first and MUST use the resolved absolute home directory as its scope path and `<home>/.agents` as its canonical path.

Each configured root is a discovery boundary, never a project scope itself, and Overlord MUST inspect its proper descendants recursively.

A descendant is a project scope when at least one of these artifact directories exists as a physical directory and contains at least one entry:

- `.agents/skills`
- `.agents/overlord/agents`
- `.claude/skills`
- `.claude/agents`
- `.codex/skills`
- `.codex/agents`

The project scope path is that descendant and its canonical path is `<project>/.agents`; definitions found below it MUST remain in that scope and MUST NOT be hoisted to a configured root or sibling.

Canonical-only and provider-native-only projects MUST both be discoverable; Git markers and `.claude/commands` alone MUST NOT create a scope.

Nested and sibling project scopes are independent; discovery MUST continue below a found project so an intentional nested scope can also be found.

Discovery MUST NOT traverse `.agents`, `.claude`, `.codex`, `.git`, `node_modules`, `vendor`, `dist`, `build`, `.cache`, or `.venv` directories.

Discovery MUST NOT follow directory symlinks; configured roots MUST be physical directories; real paths MUST be used to deduplicate overlapping roots and aliases.

When configured roots overlap, a nested configured root owns its traversal and MUST NOT become a project merely because an outer root contains it.

Project scopes MUST be emitted once in lexical path order after the user scope.

A missing, non-directory, symlinked, or unreadable discovery root and an unreadable traversed directory MUST produce an error diagnostic, MUST make fleet status `attention-required`, and MUST NOT prevent readable roots or the user scope from being processed.

## 4. Scope isolation and locations

Every scope is reconciled independently, and the same definition name MAY have different content in user and project scopes without creating a conflict.

A failure, lock, invalid definition, or conflict in one project MUST NOT block synchronization of sibling scopes.

Within one scope, a definition is identified by kind and name; structured records and actions MUST also carry the absolute `scopePath` so repeated names remain unambiguous across the fleet.

Each scope MUST use one physical layout: `.agents` contains canonical source, while managed files below `.claude` and `.codex` are provider outputs. Managed artifact roots, definition directories, definition files, and skill payload entries MUST NOT be symlinks. Native-only definitions MAY be read only as migration input before adoption and MUST NOT become an alternate steady-state source.

The canonical locations are:

```text
<scope>/.agents/skills/<name>/SKILL.md
<scope>/.agents/overlord/agents/<name>.md
```

Project-native locations are:

```text
<project>/.claude/skills/<name>/
<project>/.claude/agents/**/*.md
<project>/.codex/skills/<name>/
<project>/.codex/agents/<name>.toml
```

User-native locations default to `~/.claude/{skills,agents}` and `~/.codex/{skills,agents}`.

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` MAY override the corresponding user-native root; an absolute value is used directly and a relative value is resolved against home, never against the process working directory.

Provider override paths MUST NOT physically overlap canonical or native artifact roots in the user scope or any discovered project scope. Overlap through symlinks, filesystem aliases, or case-equivalent paths MUST produce error diagnostics and MUST block mutation in every affected scope.

Codex reads canonical skills directly from `<scope>/.agents/skills`; `.codex/skills` is a physical scan-only migration location and MUST NOT be the steady-state output for a managed skill.

Claude skills MUST be materialized as physical directories under `.claude/skills`; canonical agents MUST be deterministically rendered as physical files in both enabled native agent locations.

## 5. Canonical skill format

A canonical skill is a physical directory named for the skill and containing `SKILL.md` with YAML frontmatter.

The `name` field MUST equal the directory name, MUST contain 1–64 lowercase ASCII letters, digits, or single hyphens, and MUST have no leading, trailing, or consecutive hyphen.

The `description` field MUST be a non-empty string no longer than 1,024 characters.

The remaining skill tree is opaque payload and MUST be copied byte-for-byte with relative paths, relevant file modes, and empty directories preserved.

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

Overlord MUST inventory both provider-native files on every run without invoking provider executables or changing behavior based on executable discovery.

Claude agent inventory is recursive below `.claude/agents`; Codex agent inventory includes immediate `.toml` files below `.codex/agents`; skill inventory includes immediate child directories below each skills root and ignores Codex `.system` skills.

Every definition record MUST have one aggregate state with precedence `invalid`, `conflict`, `unadopted`, `missing`, then `synced`.

- `synced` means every required output matches canonical content, or the output reads canonical content directly.
- `missing` means valid canonical content exists and at least one required native output is absent.
- `unadopted` means valid, unambiguous native content can be adopted, or an identical Codex scan-only skill copy is redundant.
- `conflict` means valid sources for the same kind, name, and scope disagree, a same-target duplicate is ambiguous, a canonical/native pair differs, or output exists for a disabled agent target.
- `invalid` means canonical or native syntax, names, paths, overlays, entry types, or symlinks violate this specification.

Fleet status MUST be `attention-required` when any definition is missing, unadopted, conflicting, or invalid, or when any error diagnostic exists; otherwise it MUST be `ok`.

An invalid record attached to canonical content MUST block all mutations in that scope after preflight, while an invalid native-only record MUST remain untouched without blocking unrelated valid definitions in that scope.

Conflicts MUST remain untouched and MUST NOT block safe work for other definitions in the same scope.

## 8. Deterministic synchronization union

`sync` MUST converge every safe definition using deterministic rules and MUST rescan before planning, after acquiring the scope lock, after adoption, and before final reporting.

Valid canonical content is authoritative only for missing outputs; `sync` MUST create those outputs but MUST NOT overwrite a differing existing native source.

A valid native-only definition MUST be treated as migration input and adopted automatically when its kind, name, and scope are unambiguous. After adoption, only its canonical `.agents` definition is editable source.

A native-only skill present in one provider MUST be copied to canonical source, then materialized for Claude while Codex reads canonical source directly.

Native-only skills present in both providers MAY be adopted only when their complete directory trees agree; Claude is the preferred source when present.

A native-only agent present in one provider MUST be converted to canonical Markdown with that provider's overlay and an empty mapping for the other provider, then rendered to both enabled outputs.

Native-only agents present in both providers MAY be adopted only when their portable name, description, and instruction body agree; provider overlays MUST be merged into their corresponding target mappings.

Multiple same-named definitions within one provider target MUST be a conflict even when their content agrees, because source selection would be ambiguous.

After a verified adoption, formatting-only native differences MAY be replaced from the new canonical representation, but each displaced file MUST first receive a recoverable backup.

An identical `.codex/skills/<name>` copy MUST be verified against canonical content, backed up, and removed so Codex sees one canonical skill.

Nonstandard duplicate agent files made redundant by a verified adoption MUST be backed up before removal.

The operation MUST be idempotent: a fully synchronized second run MUST perform no filesystem mutations.

## 9. Additive deletion limitation

Version 0.2 has no ownership history or deletion receipts, so deleting canonical source MUST NOT automatically delete corresponding native output.

Native content left after a canonical deletion is stale migration input and may be adopted again when valid and unambiguous; it is not an alternate editable source, and users MUST remove all copies themselves when permanent deletion is intended.

Automatic removal is limited to verified redundant Codex scan-only skill copies and nonstandard duplicate agent outputs produced during safe adoption, and every such removal MUST create a backup first.

## 10. Commands

The command family is:

```text
overlord init
overlord status
overlord check
overlord sync
```

`init` MUST initialize only the user canonical directories, create a minimal `version: 2` and `roots: []` configuration when absent, and install the bundled Overlord skill when absent; it MUST NOT overwrite an existing configuration or modified bundled skill.

`status` MUST discover and inspect the complete fleet without mutation and MUST report attention while still exiting successfully after a completed inspection.

`check` MUST perform the same fleet inspection and MUST fail its assertion when attention is required.

`sync` MUST discover the complete fleet, synchronize each scope sequentially, continue after a scope-local failure, and report the final inventory plus completed and still-planned actions.

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

Actions MUST distinguish `planned` from `completed` work and MUST identify reads, writes, removals, and backups when applicable.

An error document MUST contain `status: error` and a typed error object; it MAY include actions completed before the failure and MUST omit the normal fleet payload when it could not be produced safely.

## 13. Mutation safety

Each mutating scope MUST use a per-scope lock derived from its physical path; stale lock recovery MUST be conservative, and independent scopes MAY proceed when one lock is held.

Every mutating scope MUST be inventoried before locking and again while locked so pre-lock observations never authorize stale writes.

Additive file writes and directory copies MUST refuse to replace a path that appeared after inventory and MUST be staged and atomically published where supported; intentional replacement and removal MUST retain recoverable backups.

Recoverable backups MUST be created by atomically moving each displaced artifact into a fresh UUID directory below the physical `.overlord-backups` directory adjacent to its provider artifact root, such as `.codex/.overlord-backups/<uuid>/<name>`. A symlinked or non-directory backup container MUST block the displacement, and each completed action MUST report the exact backup path.

Before writing or removing, Overlord MUST verify that the destination remains inside the scope or configured user-native boundary and MUST refuse traversal through symlinked parent directories.

Discovery and inventory MUST NOT follow symlinked artifact roots or their parent control directories. Any symlink used as a managed artifact root, definition, definition file, or skill payload entry MUST be invalid and MUST be preserved without adoption, materialization through it, or automatic removal.

Completed actions and created backups MUST remain reportable if a later step fails.

## 14. Limitations

Version 0.2 manages only filesystem-backed skills and custom agents in the documented locations.

Built-in, organization-managed, plugin-provided, marketplace, and session-only definitions are outside inventory.

Claude commands, MCP settings, rules, hooks, `CLAUDE.md`, and `AGENTS.md` are not synchronized.

Overlord does not commit generated files, alter ignore rules, run Git commands, or guarantee that an already running provider session reloads changed artifacts.

The implementation targets macOS and Linux with Node.js 22 or newer; Windows path semantics are not part of this version's contract.

## 15. Acceptance criteria

1. Running the same command from unrelated working directories discovers the same configured fleet and produces the same ordered scope set for unchanged filesystem state.
1. User definitions synchronize to user-native locations, and every discovered project's definitions synchronize only within that project.
1. Recursive discovery finds canonical-only and provider-native-only projects, preserves nested scope isolation, ignores pruned trees and symlinked directories, and reports inaccessible roots without stopping healthy scopes.
1. A valid canonical skill materializes as a physical Claude directory while Codex reads canonical source directly, and a valid canonical agent deterministically renders as a physical file for each enabled target.
1. Valid unambiguous native-only definitions are adopted and replicated automatically, identical dual-provider sources are unioned, and ambiguous or differing sources remain untouched conflicts.
1. Invalid canonical-backed state blocks only its scope, while conflicts and native-only invalid state do not block unrelated safe work.
1. Redundant scan-only or adoption duplicate removal is verified, backed up, and idempotent, while general canonical deletion does not propagate.
1. User and project definitions with the same name remain independent and are distinguishable by absolute `scopePath` in human and JSON reports.
1. `status`, `check`, `sync`, and `init` obey their documented exit behavior, and JSON output validates against schema version 2.
1. Concurrent mutation of one scope is serialized, sibling scope failures are isolated, writes are atomic where supported, and every symlink in a managed path is refused.
