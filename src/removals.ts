import type { ActionRecord } from "./types.js";

type RemovalAction = Pick<ActionRecord, "id" | "scopePath" | "reads" | "writes" | "removes">;

function ordered(paths: readonly string[] | undefined): string[] {
  return [...new Set(paths ?? [])].sort();
}

/**
 * Bind background removal approval to one exact planned action and path set.
 * Foreground synchronization does not require an approval key.
 */
export function removalApprovalKey(action: RemovalAction): string | undefined {
  if (action.removes === undefined || action.removes.length === 0) return undefined;
  return JSON.stringify([
    action.scopePath,
    action.id,
    ordered(action.reads),
    ordered(action.writes),
    ordered(action.removes),
  ]);
}
