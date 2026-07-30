# Auto-sync design draft

Status: **Draft for discussion. Not implemented and not part of the version 0.1
contract.**

This document records the proposed direction for automatic synchronization. It
does not change the explicit, stateless behavior defined by
[`spec.md`](spec.md), and none of the commands or configuration sketches below
exist yet.

## 1. Decisions recorded so far

The design starts from these product decisions:

1. `.agents` remains the canonical source of truth.
2. A canonical edit should automatically replace provider output only when that
   output still matches the version Overlord last wrote.
3. A provider-native edit should be preserved and surfaced for a decision.
4. A valid provider-only definition may be adopted automatically when it has a
   unique kind, name, source, and scope and the user has enabled that policy.
5. An entire trusted directory such as `~/Projects` may be watched recursively.
   Each project beneath it remains an independent Overlord scope.
6. Background work must never guess through a real conflict.

## 2. Goals

- Make ordinary canonical additions and edits reach Claude Code and Codex
  without a manual `overlord sync`.
- Automatically adopt unambiguous native definitions when the user has granted
  standing permission to do so.
- Detect native drift without overwriting it.
- Discover existing and newly created projects beneath explicitly trusted
  roots.
- Reuse the current validation, deterministic rendering, locking, atomic write,
  backup, and structured-decision behavior.
- Preserve an understandable audit trail for every background mutation.
- Keep foreground `status`, `check`, and `sync` useful when no watcher is
  running.

## 3. Non-goals

- Automatically resolving two independently edited copies.
- Automatically selecting between same-named definitions in overlapping
  scopes.
- Watching arbitrary parts of the filesystem that the user did not enroll.
- Running Git commands, committing generated files, or changing ignore rules.
- Synchronizing built-in, plugin, marketplace, organization-managed, or
  session-only definitions.
- Guaranteeing that an already running provider session reloads every artifact.
- Changing the canonical skill or agent formats.

## 4. Terminology

- **Receipt**: machine-local state written after a verified synchronization. It
  records the canonical digest, each generated-output digest, and the renderer
  contract that produced them.
- **Managed output**: a native output with a trustworthy receipt from a previous
  successful reconciliation.
- **Native drift**: a managed native output whose current digest differs from
  its recorded output digest.
- **Unique native definition**: one valid, portable, non-external native
  definition for a kind, name, and scope, with no conflicting source or
  effective cross-scope collision.
- **Pending decision**: durable background state that requires a person to
  choose a resolution before Overlord mutates that definition.
- **Trusted root**: a machine-local directory whose descendant projects the user
  has explicitly authorized Overlord to discover.

## 5. Reconciliation model

### 5.1 Why two-way comparison is insufficient

The version 0.1 engine compares only the current canonical and native copies.
When they differ, it cannot tell which side changed and correctly reports a
conflict.

Automatic synchronization needs a three-way comparison:

1. The canonical digest from the last successful sync.
2. The native output digest from the last successful sync.
3. The current canonical and native digests.

Agents must be reconciled per output. For example, a canonical agent edit may
be safe to propagate to an untouched Claude output while a separately edited
Codex output remains pending.

Filesystem events are only hints. Every event must cause a fresh inventory of
the affected scope before the reconciler plans a mutation.

### 5.2 Proposed transition table

<!-- markdownlint-disable MD013 -->

| Receipt | Current state | Proposed behavior |
| --- | --- | --- |
| None | Canonical only | Materialize available outputs and create a receipt. |
| None | One unique native definition only | Auto-adopt only when the trusted scope enables `autoAdopt: unique`; otherwise leave it `unadopted`. |
| None | Canonical and native agree | Enroll them as managed during an explicitly approved watcher bootstrap. |
| None | Canonical and native differ | Preserve both and create a pending conflict. |
| Present | Canonical changed; native still matches its receipt | Render and replace that untouched managed output automatically. |
| Present | Native changed; canonical still matches its receipt | Preserve native drift and create a pending decision. |
| Present | Canonical and native changed but now agree | Accept the converged state and refresh the receipt. |
| Present | Canonical and native both changed and still differ | Preserve both and create a pending decision. |
| Present | Canonical exists; managed native output is missing | Recreate the managed output. |
| Present | Canonical was deleted; native still matches its receipt | Remove the managed output only under the configured deletion policy, retaining a recoverable backup and tombstone. |
| Present | Canonical was deleted; native has drifted | Preserve the native definition and require a decision. |
| Present | Renderer contract changed | Require an explicit renderer migration; do not disguise it as an ordinary canonical edit. |
| Either | Target is unavailable | Skip that target without treating its outputs as deleted. |

<!-- markdownlint-enable MD013 -->

An unchanged output must not be rewritten. Content digests, rather than
timestamps, determine whether an output changed.

### 5.3 Receipts

A receipt would contain, at minimum:

```json
{
  "scope": "/absolute/project/path",
  "definition": {
    "kind": "agent",
    "name": "reviewer"
  },
  "canonicalDigest": "sha256:...",
  "rendererContract": "agent-v1",
  "outputs": {
    "claude": {
      "path": ".claude/agents/reviewer.md",
      "digest": "sha256:..."
    },
    "codex": {
      "path": ".codex/agents/reviewer.toml",
      "digest": "sha256:..."
    }
  }
}
```

This shape is illustrative rather than a committed schema. Skill tree digests
must cover relative paths, file bytes, relevant modes, empty directories, and
safe internal symlink targets while retaining the existing ignored-file rules.
Agent output digests cover the deterministic rendered bytes.

Receipts are not proof by themselves. Before a write, Overlord must acquire the
scope lock, rescan, and verify that the current digests still match the
preconditions used by the plan.

### 5.4 Receipt storage and recovery

Receipts should be:

- machine-local and outside canonical and provider-native directories;
- excluded from Git by location rather than by editing project ignore files;
- written atomically only after final output verification;
- keyed by a canonicalized scope path without following untrusted directory
  symlinks;
- versioned independently from the portable `overlord.yaml` schema;
- limited to paths, hashes, versions, status, and timestamps, with no definition
  content or secrets.

The exact platform paths remain open. A corrupt, missing, or incompatible
receipt must degrade to the conservative no-history behavior: differing copies
remain untouched until a decision establishes a new baseline.

Short-lived tombstones are needed after deletions and renames so stale or
reordered filesystem events do not cause an old managed output to be
auto-adopted back into canonical source.

## 6. Automatic adoption

### 6.1 Standing authorization

Enabling `autoAdopt: unique` is standing authorization for future adoptions that
meet every eligibility rule. It is narrower than permission to resolve
conflicts, delete arbitrary native definitions, rename invalid definitions, or
mark definitions external.

An automatic adoption is eligible only when the definition is:

- valid and portable without a rename;
- stable after debounce and a second validation;
- the only native source for its kind, name, and scope;
- absent from canonical source;
- not external;
- not associated with a deletion tombstone;
- free of an effective user/project or ancestor/descendant name collision;
- inside the user scope or an explicitly trusted project root.

If any condition fails, Overlord records a pending decision and changes nothing
for that definition.

### 6.2 Codex scan-only skills

Adopting from `.codex/skills` must retain the existing safe behavior: install and
verify the canonical tree, back up the original, then remove the scan-only copy.
Leaving it behind would cause Codex to discover the same skill twice.

Because this is a backed-up removal, setup must explain that
`autoAdopt: unique` includes standing authorization for this specific verified
move. Users who do not want that behavior can disable Codex scan-only
auto-adoption while retaining Claude auto-adoption.

### 6.3 Collisions

A shared name is not automatically a conflict when a receipt proves the native
copy is still the managed output. It is a collision when the history or source
is ambiguous, including:

- two differing native definitions with the same kind, name, and scope;
- a native definition and canonical definition that differ with no receipt;
- an effective user/project or ancestor/descendant collision;
- a duplicate in a Codex scan-only location;
- multiple candidate projects claiming the same native path.

The first implementation should conservatively require a decision for multiple
native sources even when they are byte-identical. Automatic deduplication can be
considered later after its scope and removal semantics are explicit.

## 7. Canonical changes, deletions, and renames

When canonical content changes and every managed native output still matches its
receipt, `.agents` wins automatically. This is the ordinary auto-sync path.

When only one output drifted, safe outputs may still update. The drifted output
stays untouched and pending; it must not block unrelated outputs, definitions,
or project scopes.

The proposed deletion behavior is:

- deleting canonical source removes untouched managed outputs with recoverable
  backups when the enrolled policy authorizes managed deletions;
- deleting a managed output while canonical remains recreates the output;
- deleting canonical source while a native output has drifted preserves that
  native output and requires a decision;
- external definitions are never removed;
- an unavailable provider is never interpreted as a deletion.

Editor and Git operations often express a rename as separate create/delete
events. The scheduler must debounce and coalesce those events before
reconciliation, and tombstones must prevent the old name from being adopted
again during the transition.

## 8. Recursive project discovery

### 8.1 Trusted roots

A watched root such as `~/Projects` orchestrates multiple project scopes. It
does not make `~/Projects` itself the canonical source for every descendant and
does not change the normal scope of foreground commands.

Trust must be machine-local and explicit because discovery may:

- create canonical files in a cloned worktree;
- expose a Claude-only project skill to Codex;
- remove a Codex scan-only duplicate during an authorized adoption.

The first enrollment should perform a complete dry-run inventory and show every
project, automatic adoption, managed deletion policy, conflict, and invalid
definition before the watcher starts mutating files.

### 8.2 Project candidates

The discovery contract still needs a final decision. The draft starting point
is:

1. A directory containing `.agents` is an explicit project scope.
2. A Git worktree root containing `.claude` or `.codex` is a native-only project
   candidate.
3. A non-Git directory containing `.claude` or `.codex` is considered only when
   the trusted-root configuration explicitly allows non-Git projects.
4. Nested Git worktrees and explicit nested `.agents` directories are
   independent scopes.
5. A relevant provider directory below a project root does not silently redefine
   the scope unless it is itself an enrolled or otherwise valid project
   candidate.

This supports repositories nested several levels below `~/Projects` without
creating `.agents` in arbitrary dependency or cache directories.

### 8.3 Traversal rules

Discovery must:

- detect projects present at startup and projects created, cloned, moved, or
  removed later;
- avoid following directory symlinks outside or within the trusted root;
- prune `.git`, `node_modules`, dependency, vendor, build, cache, and temporary
  directories;
- treat filesystem watch overflow as a reason to rescan, not as permission to
  infer an event;
- canonicalize worktree paths so aliases do not create duplicate scopes;
- keep sibling projects independent;
- apply existing cross-scope collision rules across every effective scope.

Watching a broad root is an Overlord discovery feature. It does not make every
definition beneath that root globally visible to either provider; providers
still load only the user and project locations relevant to their session.

## 9. Watcher and service architecture

### 9.1 Foreground watcher first

The first delivery should be a foreground process. A possible interface is:

```sh
overlord watch --global --root ~/Projects --auto-adopt unique
```

The spelling is provisional. A foreground watcher is easier to test, observe,
stop, and debug than an installed service.

### 9.2 Event pipeline

For each event batch, the watcher would:

1. Map the path to an enrolled scope.
2. Queue work by scope and debounce editor save sequences.
3. Acquire the existing per-scope mutation lock.
4. Re-inventory the entire affected scope.
5. Load and validate its receipts.
6. Produce a three-way reconciliation plan per output.
7. Recheck every digest precondition.
8. Stage, validate, render, and atomically apply safe actions.
9. Verify the final filesystem state.
10. Atomically commit receipts and durable pending decisions.
11. Emit structured events, logs, and deduplicated notifications.

Events caused by Overlord's own writes should converge through the same
idempotent rescan. Transaction identifiers and expected hashes can suppress
noise, but correctness must not depend on event timing.

One scope mutates serially. Independent scopes may reconcile concurrently with
a bounded worker count. A failure or decision in one definition must not block
unrelated project scopes; whether current whole-scope validation can be narrowed
safely remains a build-time design question.

### 9.3 Background service later

After foreground watching is reliable, the same process could be launched by a
user-level service:

```sh
overlord service install
overlord service status
overlord service logs
overlord service uninstall
```

These names are also provisional. macOS could use `launchd` and Linux a user
`systemd` unit. Installation must display the exact executable, arguments,
environment, config, logs, and uninstall path before writing service files.

A login service may not inherit shell variables. It must resolve and record
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HOME`, and relevant XDG paths explicitly
without storing secrets.

## 10. Background decisions and observability

A background process cannot prompt. Proposed user-facing surfaces include:

```sh
overlord watch status
overlord pending
overlord pending --json
overlord resolve '<selector>=<side>'
```

The existing selector and structured-action formats should be reused wherever
possible. A pending item should include:

- scope, kind, name, and affected targets;
- why automatic action was unsafe;
- canonical, baseline, and current native evidence;
- a concise diff and paths to a full diff;
- exact legal resolution options;
- the event time and a fingerprint used to suppress duplicate notifications.

Optional operating-system notifications should point to durable pending state;
they must not be the only record. Applying a stale decision must fail and require
a new plan.

Logs must redact secrets and should record action identifiers, paths, hashes,
backup locations, results, and timing without copying skill or agent bodies.

## 11. Provider reload expectations

Auto-sync guarantees filesystem reconciliation, not retroactive changes to an
artifact already loaded or running.

- Claude Code documents live detection for additions and edits beneath skill
  and agent directories that existed when the session started. A newly created
  top-level directory may require a restart. Updated agent definitions apply to
  the next delegation.
- Codex documents automatic skill-change detection with restart as a fallback,
  but does not promise a timing guarantee across every surface.
- Current Codex documentation does not define hot reload behavior for custom
  agent files. Overlord should recommend a new session without claiming that it
  is always required or always detected live.

Both providers document support for symlinked skill directories. That does not
establish equivalent support for agent-file symlinks, and it does not weaken
Overlord's existing canonical symlink boundaries.

## 12. Proposed configuration shape

Watch roots and receipts are machine-specific and do not belong in portable
project `overlord.yaml` files. A separate machine-local configuration might
eventually express:

```yaml
version: 1
watch:
  userScope: true
  roots:
    - path: ~/Projects
      trusted: true
      discover: git-and-initialized
      allowNonGitProjects: false
  autoAdopt:
    skills: unique
    agents: disabled
    codexScanOnly: disabled
  managedDeletion: backup-and-remove
  notifications: pending-and-os
```

This is a discussion aid, not a schema proposal. In particular, skills versus
agents, Codex scan-only moves, deletion behavior, and non-Git discovery should
remain independently configurable.

## 13. TDD build sequence

Implementation should proceed in independently testable slices:

1. **Pure three-way classifier**
   - Start with table-driven failing tests for every transition in section 5.2.
   - Classify each provider output independently.
   - Keep existing two-way foreground behavior unchanged.
2. **Stable digests and receipt store**
   - Test skill trees, modes, empty directories, ignored files, internal
     symlinks, agent renders, schema upgrades, atomic writes, and corrupt state.
   - Prove receipts commit only after verified output writes.
3. **Baseline-aware single-scope reconciliation**
   - Test canonical-only edits, native-only drift, simultaneous edits, output
     recreation, managed deletion, renderer changes, and partial failures.
   - Reuse current locks, staging, backups, and final verification.
4. **Unique auto-adoption policy**
   - Test valid unique sources, duplicate sources, invalid definitions,
     externals, cross-scope collisions, scan-only Codex moves, and tombstones.
5. **Foreground watcher**
   - Drive it with a fake clock and synthetic event source.
   - Test debounce, coalescing, self-write convergence, same-scope
     serialization, independent-scope concurrency, retries, and watch overflow.
6. **Trusted-root project discovery**
   - Test existing, nested, newly created, moved, removed, `.claude`-only,
     non-Git, ignored, symlinked, and worktree projects.
7. **Background service and notifications**
   - Test generated service definitions, explicit environment, durable pending
     state, notification deduplication, logs, and complete uninstall.
8. **Real-provider smoke tests**
   - Create a Claude-only skill and observe unique adoption.
   - Edit canonical content and observe an untouched Claude output update.
   - Edit provider output and prove it remains untouched and pending.
   - Confirm Codex discovers the adopted canonical skill.
   - Recheck provider reload behavior without promoting observations into
     unsupported contracts.

The existing engine should be separated into reusable inventory,
classification, planning, and application stages. The watcher should call those
stages rather than invoke the CLI as a subprocess.

## 14. Draft acceptance criteria

An initial auto-sync release is successful when:

1. Editing canonical content updates every unchanged managed output without a
   prompt.
2. Editing one managed native output never gets silently overwritten.
3. A valid, unique Claude-only skill is adopted under an explicitly enabled
   policy, backed up, verified, and made visible canonically.
4. A same-named or otherwise ambiguous definition remains untouched with an
   actionable pending decision.
5. Losing or corrupting receipt state cannot cause destructive reconciliation.
6. A watcher restart produces the same result as uninterrupted operation.
7. Multiple projects under a trusted root synchronize independently.
8. A newly cloned or initialized project is discovered without restarting the
   watcher.
9. Recursive discovery does not enter ignored or symlinked directory trees.
10. Existing explicit `status`, `check`, and `sync` behavior remains compatible
    when auto-sync is disabled.
11. Every automatic mutation is represented by the same structured action and
    backup evidence available to foreground commands.
12. Provider unavailability, adapter upgrades, watch overflow, partial writes,
    and service restarts fail conservatively.

## 15. Open decisions

- What exact action enrolls a trusted root and approves its initial baseline?
- Should native-only agents be eligible for auto-adoption in the first release,
  or should version one start with skills?
- Should identical definitions from multiple native sources be automatically
  deduplicated or treated as a collision?
- Should managed canonical deletion be enabled by default after root enrollment,
  or require a separate policy?
- What identifies a non-Git project safely?
- Where should machine-local config, receipts, pending state, logs, and backups
  live on macOS and Linux?
- How long should deletion tombstones and historical receipts be retained?
- Which native watcher library provides acceptable macOS and Linux behavior
  without making installation fragile?
- Should provider availability be cached, and how should installation or
  removal be detected while the watcher is running?
- How should a renderer migration be approved across many scopes?
- Should OS notifications ship with the foreground watcher or only with the
  background service?

## 16. Primary provider references

- [Claude Code skills: discovery and live change detection](https://code.claude.com/docs/en/slash-commands)
- [Claude Code custom subagents](https://code.claude.com/docs/en/sub-agents)
- [OpenAI Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [OpenAI Codex custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
