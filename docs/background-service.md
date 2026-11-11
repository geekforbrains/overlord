# Background Auto-Sync Service

Overlord includes a per-user background watcher managed through `overlord service`:

- **macOS:** `launchd` LaunchAgent at `~/Library/LaunchAgents/io.github.geekforbrains.overlord.watch.plist`
- **Linux:** `systemd --user` unit at `${XDG_CONFIG_HOME:-~/.config}/systemd/user/overlord-watch.service`

Overlord never installs a root or system-wide service.

## Lifecycle commands

```sh
overlord service install --dry-run   # print pinned binary, paths, and rendered unit without writing
overlord service install             # verify clean fleet, write unit + receipt, and start watcher
overlord service status              # verify ownership receipt, SHA-256 digest, and manager status
overlord service logs                # print recent watcher log lines
overlord service uninstall           # stop and remove owned unit + receipt (leaves fleet files intact)
```

## Safety & ownership model

1. **Clean baseline requirement:** `overlord service install` runs a read-only fleet check first and refuses to install while conflicts or canonical validation errors exist.
2. **Pinned executable:** The service definition pins the resolved absolute path of the `overlord` binary and builds a minimal deterministic `PATH` around `overlord` and `git`. If you move the `overlord` binary, re-run `overlord service install` (running `install.sh` refreshes an existing service automatically).
3. **Ownership receipt:** Overlord writes an ownership receipt containing the SHA-256 digest of the generated unit file:
   - macOS: `~/Library/Application Support/Overlord/service.json`
   - Linux: `${XDG_STATE_HOME:-~/.local/state}/overlord/service.json`
   If a plist or unit file exists without a matching receipt (or was modified outside Overlord), `install` and `uninstall` refuse to overwrite or delete it.
4. **Singleton watcher lock:** Both `overlord watch` and the background service acquire `~/.local/state/overlord/watch.lock` so two watchers cannot reconcile the same home concurrently.

## Log files

- **macOS:** `~/Library/Logs/Overlord/watch.log`
- **Linux:** `journalctl --user -u overlord-watch.service` (viewable via `overlord service logs`)
