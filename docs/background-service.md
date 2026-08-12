# Background auto-sync service

`overlord service` runs the existing `overlord watch` process under the current user's service manager. It installs a per-user LaunchAgent on macOS or a per-user systemd unit on Linux; it never installs a root daemon or system service. The generated macOS job requests a 60-second graceful-exit window, while the Linux unit requests 120 seconds; an unusually slow active synchronization can still be terminated after the manager's effective timeout.

The service has the same reconciliation and deletion safeguards as a foreground watcher. It performs an initial synchronization, watches exact managed artifact roots, rescans the fleet every 30 seconds, and stops gracefully when its manager sends `SIGTERM`.

For a compact new-machine LaunchAgent setup, use the [macOS quick start](macos-quickstart.md). The macOS path has end-to-end Apple Silicon evidence, including real automatic propagation and `KeepAlive` restart. Linux has automated lifecycle and renderer coverage but still needs broader real-host systemd validation; Intel macOS and actual logout/login or reboot recovery are also beta test targets.

## Before installation

Initialize and reconcile the machine first:

```sh
overlord status --json
overlord sync
overlord check
```

Installation requires a clean baseline. If `check` would report attention, `service install` refuses to write or activate a service. The installer never migrates legacy configuration, resolves a conflict, repairs an invalid definition, or approves a planned fleet change on the operator's behalf.

Stop every existing `overlord watch` process before installation. Overlord allows only one lifetime watcher for a home directory, whether it was started in a terminal, in `tmux`, or by a service manager. On macOS and Linux, each lock is a directory at `/tmp/overlord-locks-uid-<uid>/<24-hex-digest>.lock` below a private current-user-owned root, with its owner PID recorded inside. The path deliberately ignores `TMPDIR`, so a shell, `tmux`, launchd, and systemd cannot acquire different locks for the same home merely because their environments differ. Do not remove a live lock to bypass contention; stop its owning watcher gracefully.

Do not use `sudo`. Service commands reject root and manage only the current user's service.

## Preview and install

Preview the complete plan without writing files or invoking the service manager:

```sh
overlord service install --dry-run
```

Both preview and installation print the exact manager, service identifier, definition and receipt paths, absolute Node, Git, and Overlord CLI executables and arguments, allowlisted environment, logging destination, rendered definition, and manager commands. Review paths carefully when Node or Overlord was installed through a version manager or a source checkout.

Install, enable, and start the service:

```sh
overlord service install
overlord service status
overlord service logs
```

The service commands are human-only. `--json` is unsupported, and `--dry-run` is accepted only by `service install`. There are no separate `start`, `stop`, `restart`, or follow commands: install converges the service to enabled and running, logs returns a bounded snapshot, and uninstall stops and removes it.

## Platform layout

| Platform | Manager identity | Generated definition | Ownership receipt | Logs |
| --- | --- | --- | --- | --- |
| macOS | LaunchAgent `io.github.geekforbrains.overlord.watch` | `~/Library/LaunchAgents/io.github.geekforbrains.overlord.watch.plist` | `~/Library/Application Support/Overlord/service.json` | `~/Library/Logs/Overlord/watch.log` and `watch-error.log` |
| Linux | User unit `overlord-watch.service` | `$XDG_CONFIG_HOME/systemd/user/overlord-watch.service`, or `~/.config/systemd/user/overlord-watch.service` when unset | `$XDG_STATE_HOME/overlord/service.json`, or `~/.local/state/overlord/service.json` when unset | Current user's systemd journal |

On macOS, the agent belongs to the logged-in user's `gui/<uid>` launchd domain and uses `KeepAlive`; it is not a system LaunchDaemon. Modern macOS versions may show a directly installed LaunchAgent under Login Items or background-task settings. If the user disables it there, `service status` can report the manager state but Overlord does not bypass that choice.

During launchd activation, macOS can briefly return `Bootstrap failed: 5: Input/output error`. Overlord retries only that transient bootstrap signature: the initial attempt may be followed by at most three retries after 100, 250, and 500 milliseconds. Any other bootstrap failure, or failure after the fourth total attempt, stops the operation and triggers the normal guarded rollback instead of retrying indefinitely. This bounds the number of attempts and 850 milliseconds of scheduled backoff; it does not impose a separate deadline on an individual `launchctl` invocation.

During an owned launchd update or uninstall, `launchctl bootout` can return before the job has actually disappeared from launchd. Overlord keeps the installed plist and ownership receipt intact while it polls until launchd reports the job neither loaded nor active. That wait has a total budget shorter than the agent's configured 60-second graceful-exit window, but launchd controls the actual convergence time. If the manager becomes unreachable or the job does not settle within the bound, the operation fails before replacing or removing those ownership files and follows the normal guarded rollback path.

A LaunchAgent can have a different macOS privacy context from the terminal where `overlord check` succeeded. If service logs show permission errors for a protected, removable, or network-backed configured root, review Login Items and the relevant Privacy & Security access in System Settings, confirm that the root is mounted, then retry. Overlord reports the failure and does not attempt to bypass macOS privacy controls.

On Linux, installation enables the unit for the current user's `default.target` and starts it through `systemctl --user`. Overlord never runs `loginctl enable-linger`. Without an already enabled linger policy, availability before login or after the last logout depends on the host's user-manager policy. Enabling linger is a separate administrator or user decision, not part of Overlord installation.

## Pinned runtime and environment

The generated service invokes Node directly; it does not start a login shell or search for `overlord` on `PATH`. Installation resolves and records physical absolute paths for:

- the Node executable used to run `service install`;
- the Git executable resolved for fleet history operations;
- the installed `dist/cli.js` that handled the command; and
- the home, provider, XDG, definition, receipt, and log locations.

Only these environment variables are copied into the service definition:

- `HOME`
- `PATH`
- `OVERLORD_GIT_EXECUTABLE`
- `CLAUDE_CONFIG_DIR`
- `CODEX_HOME`
- `XDG_CACHE_HOME`
- `XDG_CONFIG_HOME`
- `XDG_DATA_HOME`
- `XDG_STATE_HOME`
- `OVERLORD_SERVICE`
- `OVERLORD_SERVICE_VERSION`

Unset provider and XDG paths are expanded to their absolute defaults. Relative provider or XDG overrides are resolved against the home directory. `PATH` is rebuilt deterministically from the pinned Node and Git executable directories plus `/usr/bin`, `/bin`, `/usr/sbin`, and `/sbin`; transient shell, IDE, and agent-wrapper entries are not retained. Other shell variables and secrets are not serialized into the service definition or receipt.

The absolute runtime is intentionally pinned. Moving or deleting the Node installation, moving the Overlord checkout, rebuilding at another path, or selecting a different version-manager runtime can make the installed service stale or unstartable. Run `overlord service install --dry-run`, then `overlord service install`, from the desired runtime after such a relocation or upgrade. Installing again safely updates an unchanged Overlord-owned definition and restarts it; it does not silently follow a moved symlink.

## Ownership and tamper safety

Overlord writes the service definition and a versioned ownership receipt as current-user-owned mode `0600` physical files; parent directories it creates are private, and any symlinked parent below the service path's trusted boundary is refused. The receipt records the platform, service identity, definition path and digest, pinned Node and Git executables and CLI arguments, allowlisted environment, Overlord version, and macOS log paths. Overlord reconstructs the receipt-described manager definition before trusting its digest. The receipt is proof of coherent Overlord ownership metadata, not permission to overwrite arbitrary manager configuration or a defense against a malicious process already running as the same user:

- A definition without a matching receipt is a collision and is left untouched.
- A loaded or enabled manager identity without the matching owned definition and receipt is also a collision.
- An invalid or mismatched receipt, a missing owned definition, or a definition whose digest changed is reported as modified.
- `service install` and `service uninstall` refuse a collision or modified state instead of replacing or deleting it.
- An unchanged owned definition from another Overlord runtime is stale and may be updated by an explicit install.

New installations write receipt format version 2. A coherent version 1 receipt and the unchanged legacy definition whose digest it records remain recognized as owned. `service status` never rewrites them. When the legacy-rendered definition differs from the current version 2 plan, status reports it as stale and an explicit `service install` upgrades both files; if the rendered definition is already byte-for-byte current and the service is healthy, install remains a no-op and need not rewrite the receipt merely to change its format number. `service uninstall` may remove either unchanged owned version. Unsupported receipt versions and incoherent legacy receipts are treated as modified and refused. For launchd, the version 1 definition is verified with its historical 120-second `ExitTimeOut`, so it is stale against the current 60-second version 2 definition. Linux continues to use `TimeoutStopSec=120`.

Use `overlord service status` to inspect the definition state, pinned runtime, and manager state. If it reports a collision or modification, inspect both paths and make an explicit ownership decision; Overlord has no force flag and does not infer which copy should win.

## Logging

Service-mode watcher lines include an ISO 8601 timestamp. A healthy 30-second periodic scan with no actions, non-informational diagnostics, or pending removals is silent. Startup, shutdown, completed actions, attention states, retries, and errors remain visible.

`overlord service logs` is a bounded snapshot, not a follow mode:

- macOS reads at most the most recent 64 KiB from each launchd log file;
- Linux requests the most recent 200 lines for `overlord-watch.service` from the current user's journal without a pager.

Overlord does not delete logs during uninstall. systemd journal retention remains a host policy. The macOS files are append-only launchd destinations, so long-term rotation or retention remains the operator's responsibility.

That operator-managed macOS retention is the supported contract for this release; Overlord does not rotate the files itself. The bounded view is historical, so an old error can remain visible after a later successful cycle. Use current `overlord check` and `overlord service status` output to determine present health.

Prepare a complete skill or agent before renaming it into a managed artifact root. If a watcher observes a newly created definition directory before its required file or frontmatter has been written, it reports the incomplete definition, preserves it, and normally converges on a later event or periodic scan after the write finishes. Staging below a non-managed directory such as `<project>/.agents/.staging` avoids that transient noise.

## Moving from a foreground or tmux watcher

Stop the old watcher gracefully before installing the service. For the example session name used in the migration guide:

```sh
tmux attach-session -t overlord-watch
# Press Ctrl-C and wait for "watch: stopped", then exit the tmux shell.

overlord check
overlord service install --dry-run
overlord service install
overlord service status
```

Do not use `tmux kill-session` as the normal handoff: it does not provide the same explicit `SIGINT`/`SIGTERM` shutdown and completion check. If a foreground watcher still holds the lifetime lock, the service cannot start another watcher for that home; inspect `service status` and `service logs`, stop the old watcher, and retry installation.

## Status, logs, and uninstall

```sh
overlord service status
overlord service logs
overlord service uninstall
```

`status` is read-only. It distinguishes absent, current, stale, modified, and colliding definitions and reports whether the user service manager is reachable and the service is loaded, active, and enabled where those distinctions exist. Installation and uninstall refuse to mutate files when the user manager is unavailable.

`uninstall` stops and disables the user service, then removes only the unchanged Overlord-owned manager definition and ownership receipt. It preserves all canonical and provider definitions, `~/.agents/overlord/overlord.yaml`, the reconciliation ledger and Git history, project files, and service logs. It does not disable Linux linger or change any other manager policy.

After uninstalling, `overlord watch` remains available as the foreground primitive.

## Platform references

- Apple documents per-user agents in `~/Library/LaunchAgents`, `ProgramArguments`, `KeepAlive`, standard-output paths, file ownership, and `SIGTERM` handling in [Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) (archived guide, updated 2016). Apple describes the macOS 13+ app-bundled replacement path in [Updating helper executables from earlier versions of macOS](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos); Overlord is currently source-only and installs the documented per-user plist directly.
- The systemd v261.2 manuals define [unit load paths and enablement](https://github.com/systemd/systemd/blob/v261.2/man/systemd.unit.xml), [service restart and stop behavior](https://github.com/systemd/systemd/blob/v261.2/man/systemd.service.xml), and [`systemctl --user`](https://github.com/systemd/systemd/blob/v261.2/man/systemctl.xml). Older supported distributions may ship earlier systemd releases.
- The systemd v261.2 [`loginctl` manual](https://github.com/systemd/systemd/blob/v261.2/man/loginctl.xml) explains that enabling linger starts a user's manager at boot and keeps it after logout; Overlord deliberately leaves that policy unchanged.
