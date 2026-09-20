# Changelog

All notable changes to Overlord are documented here.

## [Unreleased]

### Fixed

- Leave Claude-managed `synced` and `.trash` skill storage untouched, including case variants and configured Claude roots. Reject canonical collisions and block old ledger operations for these reserved names instead of reporting Claude's containers as invalid local skills.

## [0.3.0-beta.1] - 2026-08-12

This is a macOS-first prerelease for broader testing. The launchd path has end-to-end Apple Silicon evidence; real-host systemd, Intel macOS, and actual logout/login or reboot recovery remain explicit beta test targets.

### Added

- Added `overlord watch` as a foreground macOS and Linux auto-sync process with an initial synchronization, exact managed-root watching, a 750 millisecond quiet-period debounce, and a full fleet rescan every 30 seconds.
- Added graceful `SIGINT` and `SIGTERM` shutdown for the foreground watcher.
- Added human-only `overlord service install [--dry-run]`, `service status`, `service logs`, and `service uninstall` commands for a user LaunchAgent on macOS or user systemd unit on Linux.
- Added existing-machine migration and background-service runbooks covering off-fleet backups, legacy configuration, definition audits, baseline-free conflicts, Git review, foreground-to-service handoff, platform paths, runtime pinning, logs, and safe uninstall.
- Added a macOS quick start covering an exact source release, reviewed initialization, LaunchAgent installation, automatic-sync verification, and safe removal.

### Changed

- Kept `--json` as a single-document option for the one-shot commands; `watch --json` is unsupported and no streaming JSON contract was added.
- Made service installation require a clean fleet baseline and print the exact service plan, including its absolute Node and CLI runtime, allowlisted environment, generated definition, state and log paths, and manager commands.
- Added timestamped service-mode watcher output and suppressed healthy no-op periodic scan lines while retaining action, attention, retry, and error reporting.
- Rebuilt service `PATH` deterministically around pinned physical Node and Git executables so transient shell, IDE, and agent-wrapper paths are not captured.
- Made new ownership receipts format version 2 while continuing to verify coherent version 1 installations with their historical renderer and upgrading them on explicit reinstall when stale.
- Set launchd `ExitTimeOut` to 60 seconds, retained systemd `TimeoutStopSec` at 120 seconds, and bounded the transient launchd bootstrap I/O retry to three delayed retries.
- Kept background integration strictly per-user and left Linux linger policy unchanged.
- Made operator-managed retention the explicit macOS log policy for this release and documented that historical log errors do not override a current clean check.
- Added macOS CI alongside Ubuntu for Node.js 22 and 24, and made `npm pack` rebuild ignored production output before packaging.
- Recorded launchd as the end-to-end validated beta path while keeping real-host systemd, Intel macOS, and logout/login or reboot validation as explicit tester targets.

### Safety

- Holds a watcher removal until the same complete removal action remains present after a two-second grace period and a second full synchronization cycle.
- Uses a stable private per-UID lock root below `/tmp`, independent of `TMPDIR`, so foreground, tmux, and service-managed watchers cannot reconcile one home concurrently even when their environments differ.
- Records an ownership receipt and definition digest so install and uninstall refuse unowned, mismatched, or externally modified service files.
- Serializes service lifecycle operations and verifies receipt coherence, file ownership and mode, physical parent chains, manager enablement, and rollback state before trusting or mutating an installation.
- Waits for launchd `bootout` to converge during owned updates and uninstall, retaining the plist and receipt throughout a bounded poll and failing safely if launchd does not settle.
- Makes uninstall remove only the unchanged Overlord-owned manager definition and receipt while preserving definitions, fleet configuration, ledger and Git history, project files, and logs.

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

[Unreleased]: https://github.com/geekforbrains/overlord/compare/v0.3.0-beta.1...HEAD
[0.3.0-beta.1]: https://github.com/geekforbrains/overlord/compare/v0.2.0...v0.3.0-beta.1
[0.2.0]: https://github.com/geekforbrains/overlord/releases/tag/v0.2.0
