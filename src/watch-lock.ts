import { join } from "node:path";

import { acquireScopeLock } from "./filesystem.js";

/**
 * Use a stable pseudo-scope identity for the one watcher allowed to supervise a
 * user fleet. The underlying lock lives in the operating-system temporary
 * directory and includes stale-owner recovery.
 */
export function acquireWatchLifetimeLock(home: string): Promise<() => Promise<void>> {
  return acquireScopeLock(join(home, ".agents", ".git", "overlord", "watch-lifetime"));
}
