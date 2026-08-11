# Changelog

All notable changes to Overlord are documented here.

## [0.2.0] - 2026-08-11

### Added

- Added `init` to create the user canonical source, its dedicated Git repository, the roots configuration, the bundled workflow skill, and the initial managed commit.
- Added recursive discovery from a small list of configured roots, including definitions located directly in a configured root.
- Added scope-local synchronization for user and project skills and custom agents across canonical, Claude, and Codex locations.
- Added a machine-local reconciliation ledger for tracking additions, edits, deletions, and incompatible concurrent changes from the last successful synchronization.
- Added automatic, fixed-message Git commits for managed changes in `~/.agents` before user provider outputs are updated.
- Added schema-versioned JSON output with explicit actions, diagnostics, conflicts, and commit metadata.

### Changed

- Made each scope's `.agents` directory the durable source after synchronization while still accepting unambiguous edits made in provider-native files.
- Simplified fleet configuration to a single `roots` list with no configuration-version or automatic-migration mechanism.
- Made Codex read skills directly from `.agents/skills`; `.codex/skills` is no longer discovered or synchronized.
- Defined the synchronized skill value as Git-representable file paths, bytes, and executable bits.
- Made clean repeated synchronization leave both Git and reconciliation-ledger state untouched.

### Removed

- Removed adoption, scan-only, persistent-backup, upgrade, and conflict-resolution command flows that were outside the current opinionated model.
- Removed project-level Git management; Overlord never inspects, initializes, stages, commits, or pushes a discovered project's repository.

### Safety

- Rejects symlinks and nested Git metadata in managed definition trees.
- Detects overlapping artifact roots and scope aliases before mutation.
- Preserves unrelated staged content and never pushes the user source repository.
- Stops user provider propagation when the required canonical commit fails.
- Keeps conflicts and invalid definitions visible without choosing a winner.

[0.2.0]: https://github.com/geekforbrains/overlord/releases/tag/v0.2.0
