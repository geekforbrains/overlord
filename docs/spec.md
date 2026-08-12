# Overlord specification

Status: normative for the current source tree.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY describe requirements on conforming implementations.

## 1. Purpose

Overlord keeps filesystem-backed Claude Code and Codex skills and custom agents synchronized through one durable `.agents` source in the user scope and in every discovered project. Intentional edits SHOULD target `.agents`, but provider-native files are tracked endpoints because a provider may create, modify, or delete them while helping the user. After every successful reconciliation, `.agents` contains the resulting canonical definition for that scope.

Every status, check, and sync invocation, including each synchronization cycle started by `watch` directly or by a managed user service, operates on the same fleet regardless of the process working directory: the user scope plus independent project scopes found below configured discovery roots.

Overlord is a filesystem reconciler and maintains Git history for the user source at `~/.agents`. It is not an agent runtime, provider launcher, project registry, or source-control manager for project repositories.

## 2. Fleet configuration

The only Overlord configuration file is `~/.agents/overlord/overlord.yaml`, where `~` means the injected or operating-system home directory.

The configuration has this shape:

```yaml
roots:
  - ~/Projects
  - /absolute/path/to/another-parent
```

`roots` MUST be an array; unknown keys MUST make the configuration invalid. The configuration has no version field. Only this current, roots-only shape is accepted. Overlord MUST NOT infer, translate, or rewrite an earlier configuration shape automatically; the user must migrate unsupported configuration explicitly. Breaking configuration changes MUST be documented when they are introduced.

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

Within `watch`, a planned removal action MUST NOT execute on its first observation. Overlord MUST retain that action's complete scope, definition, read, write, and removal path identity, wait at least two seconds, and perform a second full inventory and reconciliation cycle. The removal MAY proceed only when the second cycle contains the same action identity. A changed, missing, or no-longer-planned action MUST invalidate its prior confirmation and begin a new grace period if a removal remains planned. Each additional removal action requires its own confirmation. Safe non-removal work MAY proceed while removal confirmation is pending.

## 10. Commands

The command family is:

```text
overlord init
overlord status
overlord check
overlord sync
overlord watch
overlord service install [--dry-run]
overlord service status
overlord service logs
overlord service uninstall
```

`init` MUST validate any existing fleet configuration in its current roots-only format before it creates or validates the dedicated user Git repository or performs another initialization write. An invalid or unsupported configuration MUST fail initialization without creating `~/.agents/.git`, rewriting the configuration, or attempting an automatic migration.

After that validation, `init` MUST create the user canonical root when needed and create or validate a dedicated physical Git repository rooted exactly there. It MUST reject unsupported `.git` files or symlinks and repositories whose work-tree top level is elsewhere. It MUST create a minimal `roots: []` configuration when absent, install the bundled Overlord skill when absent, commit the initial managed canonical state with the fixed subject `overlord: initialize`, and initialize the private synchronization ledger below `.git`. On first initialization, the managed capture MUST include existing physical user canonical sources below `~/.agents/skills` and `~/.agents/overlord/agents`, rather than only files created by `init`; content already represented by the repository's `HEAD` need not be recommitted. A repeated no-op `init` MUST NOT create another commit.

`init` MUST NOT overwrite an existing physical `~/.agents/skills/overlord/SKILL.md` whose bytes differ from the bundled skill; it MUST preserve that file and report a warning. Initialization MUST NOT copy provider-native definitions into canonical source, migrate an earlier layout, or resolve definition conflicts. Later `sync` and `watch` cycles MUST continue to leave genuine conflicts untouched under sections 7 through 9 rather than choose a side automatically.

`status`, `check`, `sync`, and `watch` MUST require an existing dedicated user repository. `init` is the normal way to establish it, but a valid manually initialized repository, including an unborn repository, is accepted without a hidden initialization marker. Before fleet discovery the commands MUST validate the repository without creating the canonical root, `.git`, a commit, or ledger state. An absent or invalid repository MUST fail as a top-level permission error.

`status` MUST discover and inspect the complete fleet without mutation and MUST report attention while still exiting successfully after a completed inspection. It MUST NOT stage or commit files or create or update ledger state.

`check` MUST perform the same read-only fleet inspection and MUST fail its assertion when attention is required.

`sync` MUST discover the complete fleet, reconcile each scope sequentially, continue after a scope-local failure, and report the final inventory plus completed and still-planned actions.

For the user scope, `sync` MUST apply every safe canonical write and deletion for the invocation before provider propagation, stage the changed fleet configuration plus the Overlord-managed canonical paths selected by safe reconciliation, and create at most one commit with the fixed subject `overlord: synchronize`. It MUST then report the commit SHA, sorted originating endpoints when applicable, and committed canonical files using fixed program output. An LLM MUST NOT compose the message or select staged files. Other staged and working-tree changes MUST remain excluded and preserved. A clean/no-op sync MUST NOT create a commit, and Overlord MUST NOT push.

User provider propagation MUST begin only after that commit succeeds or Git establishes that the selected canonical paths are already clean. If the user commit fails, `sync` MUST stop before distributing those uncommitted canonical changes or advancing their ledger receipts; the canonical working-tree changes MUST remain visible for diagnosis and retry. Project canonical changes MUST be reconciled without invoking Git in the project repository, regardless of whether a project repository exists.

On an existing machine, `watch` SHOULD begin only after the operator has established a clean or explicitly understood baseline: `init` has completed, `status` has been reviewed, and an intentional foreground `sync` has either reached `ok` or left only attention states the operator understands. `watch` is continuous reconciliation, not an unattended migration or conflict-resolution command.

`watch` MUST run as a foreground macOS or Linux process and MUST begin with a complete fleet synchronization cycle. After each cycle it MUST refresh filesystem watchers for the exact managed canonical and provider artifact roots of the user scope and every discovered project scope. It MUST also observe the user fleet configuration so a configuration edit can refresh discovery. It MUST NOT recursively watch a configured discovery root, an entire project tree, or the complete user `.agents` repository as a substitute for those exact roots. When an exact managed root is absent, a watcher MAY observe its nearest existing physical parent only to detect creation of that root and MUST ignore unrelated paths.

Filesystem events MUST be treated only as invalidation hints. Events MUST use a 750 millisecond quiet-period debounce and then start a complete fleet synchronization cycle. Only one cycle MAY run at a time; an event received during a cycle MUST request one subsequent cycle rather than start concurrent reconciliation.

Independently of filesystem events, `watch` MUST start a complete fleet discovery and synchronization cycle every 30 seconds. This periodic cycle MUST discover newly populated projects, recover from missed events, and refresh the exact managed-root watch set.

On `SIGINT` or `SIGTERM`, `watch` MUST stop accepting new cycles, cancel its timers, close its filesystem watchers, allow any active cycle to settle safely, and then exit. The foreground command itself MUST NOT install, enable, or manage a launchd agent, systemd unit, or other background service.

Every `watch` process MUST acquire one lifetime lock derived from the absolute home-scoped pseudo-identity `<home>/.agents/.git/overlord/watch-lifetime` before its initial synchronization and MUST hold that lock through shutdown. Lock contention MUST prevent a second foreground, tmux-hosted, or service-managed watcher from reconciling the same home identity. On macOS and Linux, its exact layout MUST be `/tmp/overlord-locks-uid-<uid>/<24-hex-digest>.lock`, where the digest is the first 24 hex characters of SHA-256 over the pseudo-identity's real path when it exists or its normalized absolute path otherwise. The location MUST NOT depend on `TMPDIR` or another inherited environment value. The per-UID root MUST be a physical current-user-owned directory with no group or world permissions; the `.lock` entry MUST be a directory containing its owner PID. This fleet-wide lifetime lock is separate from the shorter per-scope mutation locks.

The `service` command family MUST be supported only on macOS and Linux, MUST reject execution as root, and MUST manage only the current user's service. It is a platform adapter around the same foreground `watch` process, not a second reconciliation engine. macOS MUST use the per-user LaunchAgent label `io.github.geekforbrains.overlord.watch` at `~/Library/LaunchAgents/io.github.geekforbrains.overlord.watch.plist`. Linux MUST use the user unit `overlord-watch.service` below the resolved absolute `XDG_CONFIG_HOME/systemd/user`, defaulting to `~/.config/systemd/user`. No service command MAY install a root LaunchDaemon or system unit.

Before `service install` writes a definition or invokes a manager, it MUST perform the same read-only fleet inspection as `check` and require an `ok` baseline with no unresolved conflict, invalid definition, diagnostic requiring attention, or planned reconciliation action. Installation MUST NOT initialize the user repository, migrate configuration, synchronize a proposed action, or resolve a conflict. Both ordinary and `--dry-run` installation MUST print the exact platform manager and service identifier; definition, receipt, and log locations; physical absolute Node and Git executables; physical absolute CLI path and arguments; complete allowlisted environment; rendered manager definition; and manager commands before any mutation. `--dry-run` MUST stop after that preview without writing a file or invoking the service manager.

The service MUST invoke the pinned Node executable and CLI directly without a login shell or executable search. Installation MUST resolve the physical Git executable used for fleet history operations, serialize it as `OVERLORD_GIT_EXECUTABLE`, and the watcher MUST use that absolute executable for Git operations. The only serialized environment variables MUST be `HOME`, `PATH`, `OVERLORD_GIT_EXECUTABLE`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `OVERLORD_SERVICE`, and `OVERLORD_SERVICE_VERSION`. Provider and XDG paths MUST be explicit absolute paths, with a relative operator-supplied value resolved against home. `PATH` MUST be deterministic and contain only the pinned Node and Git executable directories plus `/usr/bin`, `/bin`, `/usr/sbin`, and `/sbin`; inherited shell, IDE, and agent-wrapper entries MUST NOT be retained. No other inherited environment variable or secret MAY be copied into the definition or ownership receipt.

Installation MUST pin the physical absolute Node and CLI files used for that invocation and record the resolved physical Git executable. A runtime or checkout relocation MUST require an explicit subsequent `service install`; a generated definition MUST NOT silently follow a moved symlink or search a newer runtime. Reinstallation MAY update a stale service only when an intact Overlord receipt proves ownership and the installed definition still matches its recorded digest.

The generated manager definition and versioned ownership receipt MUST be physical, atomically published current-user-owned mode `0600` files, Overlord-created state directories MUST be private, and symlinked parents below each trusted service-path boundary MUST be refused. The macOS receipt MUST be `~/Library/Application Support/Overlord/service.json`; the Linux receipt MUST be `overlord/service.json` below the resolved absolute `XDG_STATE_HOME`, defaulting to `~/.local/state`. A receipt MUST record the platform, service identifier, definition path and digest, Node and Git executables, CLI arguments, allowlisted environment, Overlord version, and receipt format version, plus platform log paths where applicable. Before trusting its digest, Overlord MUST reconstruct the receipt-described definition using that format version's rendering semantics and require the metadata, environment, arguments, service identity, and reconstructed digest to be coherent. A definition without a matching receipt, a manager identity loaded or enabled without its matching owned definition and receipt, an invalid or mismatched receipt, a missing owned definition, or a definition whose current digest differs from the receipt MUST be reported without replacement or removal. Install and uninstall MUST have no force or automatic-adoption path for such a collision or modification.

New receipts MUST use format version 2. A coherent format version 1 receipt whose installed definition still matches its recorded digest MUST remain recognized as owned. It MUST be classified as stale when its historical rendering differs from the current desired definition and MAY remain current when the bytes are identical. `service status` MUST report that state without mutation. An explicit `service install` MUST replace a stale legacy definition and receipt with the current version 2 forms; an unchanged healthy current installation MUST remain a no-op and need not rewrite an otherwise coherent receipt solely to change its format number. `service uninstall` MAY remove the unchanged owned version 1 pair without first upgrading it. An unsupported receipt version or incoherent legacy receipt MUST be classified as modified and MUST be refused. Receipt reconstruction MUST preserve the historical version 1 rendering rules, including a 120-second launchd `ExitTimeOut`, while the current version 2 launchd definition uses 60 seconds.

A successful install MUST enable and start the service, and an unchanged healthy repeated install MUST be a no-op. The generated macOS job MUST set launchd `ExitTimeOut` to 60 seconds, and the Linux unit MUST set systemd `TimeoutStopSec` to 120 seconds; shutdown settling remains bounded by the manager's effective timeout. A launchd `bootstrap` failure matching `Bootstrap failed: 5: Input/output error` MAY be retried after 100, 250, and 500 milliseconds, for at most four total attempts including the initial attempt. No other activation error MAY use this retry, and exhaustion MUST fail the operation rather than retry indefinitely. After a successful launchd `bootout` during an owned update or uninstall, Overlord MUST keep the existing definition and receipt intact while it polls manager state until the job is neither loaded nor active. That polling MUST have a total budget shorter than the 60-second `ExitTimeOut`; no fixed convergence time within the budget is promised. Manager unreachability or failure to converge within the bound MUST fail before those ownership files are replaced or removed. Install and uninstall MUST serialize service lifecycle mutations for one home and refuse filesystem mutation when the current user's service manager is unreachable. If an install, update, activation, or uninstall fails after mutation starts, Overlord MUST make a best-effort rollback to the exact prior owned definition, receipt, enablement, loaded, and active state without overwriting a concurrent external edit.

`service status` MUST be read-only and MUST report absent, current, stale, externally modified, and colliding definition states together with the pinned runtime and reachable, loaded, active, and enabled manager state where the platform exposes those distinctions. An active manager process alone MUST NOT be reported as healthy when ownership or runtime state is stale or modified.

When `watch` detects the explicit service environment marker, every emitted watcher line MUST begin with an ISO 8601 timestamp. A healthy periodic-scan cycle with no completed action, non-informational diagnostic, or pending removal MUST produce no output; startup, shutdown, actions, attention, retries, and errors MUST remain reportable. macOS standard output and error MUST append to `~/Library/Logs/Overlord/watch.log` and `watch-error.log`; Linux output MUST use the current user's systemd journal.

`service logs` MUST return a bounded, non-following view. On macOS it MUST read no more than the most recent 64 KiB from each physical log file. On Linux it MUST request no more than the most recent 200 lines for `overlord-watch.service` from the user journal without a pager. The command MUST refuse a symlink or non-file macOS log path.

`service uninstall` MUST stop and remove only the unchanged Overlord-owned service definition and receipt and MUST disable the Linux user unit. It MUST preserve every canonical and provider definition, fleet configuration, reconciliation ledger and Git record, project file, and service log. It MUST NOT remove or enable Linux linger, change another user-manager policy, or delete a colliding or modified service file.

The macOS LaunchAgent follows the logged-in user's launchd lifecycle. The Linux unit follows the existing user systemd manager policy; installation and uninstall MUST NOT invoke `loginctl enable-linger` or `disable-linger`. Service availability before login or after the final logout is therefore outside Overlord's guarantee.

The only operational output option for the one-shot `init`, `status`, `check`, and `sync` commands is `--json`. `watch` and every `service` subcommand MUST reject `--json`; the watcher has human-readable output but no streaming JSON contract, and the service-management surface is intentionally human-only. `--dry-run` MUST be accepted only by `service install`. `--help` and `--version` are informational, and a command is required.

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

For the one-shot `init`, `status`, `check`, and `sync` commands, `--json` MUST emit exactly one JSON document to standard output on success or failure and MUST conform to `docs/schemas/output.schema.json` with `schemaVersion: 2`. The schema and its single-document contract do not include `watch` or `service`.

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

A single file MUST be published atomically, so a partially written file is never observable at its destination. A directory copy is validated and staged first, but its entries are published individually into the destination, so publication of a skill tree as a whole is not atomic. A failure partway through MUST leave the partial tree in place rather than deleting entries it did not create, and MUST report the created paths as a completed action so the incomplete output is recoverable and visible. Overlord does not guarantee that a provider never observes a partially materialized skill directory.

Before writing or removing, Overlord MUST verify that the destination remains inside the scope or configured user-native boundary and MUST refuse traversal through symlinked parent directories.

Discovery and inventory MUST NOT follow symlinked artifact roots or their parent control directories. Any symlink used as a managed artifact root, definition, definition file, or skill payload entry MUST be invalid and MUST be preserved without incorporation, materialization through it, or automatic removal.

Completed actions and Git commits MUST remain reportable if a later step fails.

## 14. Limitations

Overlord manages only filesystem-backed skills and custom agents in the documented locations.

Built-in, organization-managed, plugin-provided, marketplace, and session-only definitions are outside inventory.

Claude commands, MCP settings, rules, hooks, `CLAUDE.md`, and `AGENTS.md` are not synchronized.

Overlord runs Git only for its user source at `~/.agents`. It MUST NOT commit generated provider files, alter project ignore rules, inspect or otherwise invoke Git in project repositories, push the user repository, or guarantee that an already running provider session reloads changed artifacts.

The implementation targets macOS and Linux with Node.js 22 or newer; Windows path semantics are not part of this version's contract.

Background auto-sync is limited to the current user's LaunchAgent on macOS or user systemd manager on Linux. Overlord does not manage a root/system service, Linux linger, macOS app-bundled `SMAppService` registration, or another service manager.

## 15. Acceptance criteria

1. Running the same command from unrelated working directories discovers the same configured fleet and produces the same ordered scope set for unchanged filesystem state.
1. User definitions synchronize to user-native locations, and every discovered project's definitions synchronize only within that project.
1. Recursive discovery considers each configured root and its descendants, finds canonical-only and provider-native-only projects, preserves nested scope isolation, ignores pruned trees, never traverses a symlinked directory, still records a scope whose artifact root is a symlink so it is reported rather than omitted, and reports inaccessible roots without stopping healthy scopes.
1. A valid canonical skill materializes as a physical Claude directory while Codex reads canonical source directly, and a valid canonical agent deterministically renders as a physical file for each enabled target.
1. A single-sided canonical or provider addition or edit is incorporated into canonical and propagated within that scope, while incompatible concurrent changes remain untouched conflicts.
1. Invalid canonical-backed state blocks only its scope, while conflicts and provider-only invalid state do not block unrelated safe work.
1. A tracked single-sided deletion propagates within its scope, modification-versus-deletion conflicts remain untouched, and an untracked absence is materialized rather than treated as deletion.
1. User and project definitions with the same name remain independent and are distinguishable by absolute `scopePath` in human and JSON reports.
1. `init` validates an existing roots-only configuration before repository creation, rejects unsupported configuration without migration, creates or validates `~/.agents` as Overlord's only dedicated Git repository, preserves a modified bundled skill, and captures existing physical user canonical sources in managed history; a missing user repository makes inspection fail without mutation, user-source changes are committed once before provider propagation, and project repositories receive no Git operations.
1. `status`, `check`, `sync`, and `init` obey their documented exit behavior, their JSON output validates against schema version 2, and `watch --json` plus `service --json` are rejected without changing the one-shot schema.
1. `watch` performs an initial sync, observes only exact managed roots with a 750 millisecond quiet-period debounce, performs a full rescan every 30 seconds, serializes cycles, and shuts down gracefully on `SIGINT` and `SIGTERM`.
1. A removal proposed within `watch` remains pending until the identical complete removal action survives a two-second grace period and a second full cycle; a changed action restarts confirmation.
1. A stable current-UID lock below `/tmp`, independent of `TMPDIR`, permits only one watcher for the same absolute home identity regardless of whether it is foreground, tmux-hosted, or service-managed.
1. `service install --dry-run` prints the exact plan without mutation or manager access; an ordinary install first requires a clean baseline and then creates only the current user's deterministic launchd or systemd definition and ownership receipt with a pinned absolute runtime and allowlisted environment.
1. A coherent version 1 receipt is verified with its historical renderer without mutation, upgraded to version 2 by an explicit install when stale, and allowed to remain when byte-identical and healthy, while unsupported or incoherent receipts remain untouched as modified state.
1. launchd uses a 60-second `ExitTimeOut` and a bounded transient bootstrap retry, while systemd uses a 120-second `TimeoutStopSec`.
1. An owned launchd update or uninstall retains its definition and receipt until bounded manager polling confirms that `bootout` has converged; an unreachable manager or non-settling job fails without replacing or removing those files.
1. Service status reports ownership, runtime, and manager health without mutation; logs are timestamped, quiet for healthy no-op scans, and bounded when read through the CLI.
1. A colliding, mismatched, or modified service definition remains untouched, and uninstall removes only an unchanged owned definition and receipt while preserving fleet content, state, history, logs, and linger policy.
1. Concurrent mutation of one scope is serialized, sibling scope failures are isolated, every file write is atomic, an interrupted skill copy leaves a reported partial tree rather than a corrupted or silently discarded one, and every symlink in a managed path is refused.
