import { watch as watchPath } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { configPath, loadConfig } from "./config.js";
import { synchronize as synchronizeFleet, type SynchronizeOptions } from "./engine.js";
import { removalApprovalKey } from "./removals.js";
import { resolveTargetPaths } from "./targets.js";
import type { EngineOptions, OutputDocument, Scope } from "./types.js";

export const WATCH_DEBOUNCE_MS = 750;
export const WATCH_SCAN_INTERVAL_MS = 30_000;
export const WATCH_REMOVAL_GRACE_MS = 2_000;

const WATCH_RETRY_INITIAL_MS = 1_000;
const WATCH_RETRY_MAX_MS = 30_000;

export interface WatchTarget {
  /** Existing physical directory passed to fs.watch. */
  path: string;
  recursive: boolean;
  /** Desired paths used to discard unrelated parent-sentinel events. */
  interests: readonly string[];
}

export interface WatchHandle {
  close(): void;
}

export interface WatchCallbacks {
  change(eventType: string, filename: string | null): void;
  error(error: unknown): void;
}

export type WatchFactory = (target: WatchTarget, callbacks: WatchCallbacks) => WatchHandle;

export interface WatchTimers {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export type WatchReport =
  | {
    type: "started" | "cycle";
    document: OutputDocument;
    reasons: readonly string[];
    watchedPaths: readonly string[];
    pendingRemovals: number;
  }
  | {
    type: "error";
    phase: "sync" | "watch";
    error: unknown;
    retryInMs: number;
  }
  | { type: "stopped" };

type SynchronizeFunction = (
  options: EngineOptions,
  synchronizeOptions?: SynchronizeOptions,
) => Promise<OutputDocument>;

export interface WatchFleetOptions {
  engine: EngineOptions;
  signal: AbortSignal;
  synchronize?: SynchronizeFunction;
  watchFactory?: WatchFactory;
  timers?: WatchTimers;
  debounceMs?: number;
  scanIntervalMs?: number;
  removalGraceMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  onReport?: (report: WatchReport) => void;
}

interface DesiredWatch {
  path: string;
  boundary: string;
  recursive: boolean;
  interest: string;
}

interface ActiveWatch {
  target: WatchTarget;
  handle: WatchHandle;
  token: object;
}

interface RemovalCandidate {
  firstSeenAt: number;
  graceTriggered: boolean;
}

const defaultTimers: WatchTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle),
};

function realWatchFactory(target: WatchTarget, callbacks: WatchCallbacks): WatchHandle {
  let intentionallyClosed = false;
  const watcher = watchPath(
    target.path,
    { encoding: "utf8", recursive: target.recursive },
    (eventType, filename) => callbacks.change(
      eventType,
      filename === null ? null : filename.toString(),
    ),
  );
  watcher.on("error", callbacks.error);
  watcher.once("close", () => {
    if (!intentionallyClosed) callbacks.error(new Error(`Filesystem watcher closed for '${target.path}'`));
  });
  return {
    close() {
      intentionallyClosed = true;
      watcher.close();
    },
  };
}

function positiveDuration(value: number | undefined, fallback: number, allowZero = false): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const minimum = allowZero ? 0 : 1;
  return Math.max(minimum, Math.floor(value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "darwin" ? absolute.normalize("NFD").toLowerCase() : absolute;
}

function containsPath(parent: string, child: string): boolean {
  const nested = relative(resolve(parent), resolve(child));
  return nested === "" || (nested !== ".." && !nested.startsWith(`..${sep}`));
}

function pathsRelated(left: string, right: string): boolean {
  const normalizedLeft = normalizedPath(left);
  const normalizedRight = normalizedPath(right);
  return containsPath(normalizedLeft, normalizedRight) || containsPath(normalizedRight, normalizedLeft);
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function nearestPhysicalDirectory(path: string, boundary: string): Promise<string | undefined> {
  const absolutePath = resolve(path);
  const absoluteBoundary = resolve(boundary);
  if (!containsPath(absoluteBoundary, absolutePath)) return undefined;

  let current = absolutePath;
  while (containsPath(absoluteBoundary, current)) {
    try {
      const metadata = await lstat(current);
      if (!metadata.isSymbolicLink() && metadata.isDirectory()) return current;
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
    }
    if (normalizedPath(current) === normalizedPath(absoluteBoundary)) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function scopeWatches(scope: Scope, options: EngineOptions): DesiredWatch[] {
  const paths = resolveTargetPaths(scope, options);
  const claudeBoundary = scope.type === "user" ? dirname(dirname(paths.claude.skills)) : scope.path;
  const codexBoundary = scope.type === "user" ? dirname(dirname(paths.codex.agents)) : scope.path;
  return [
    {
      path: join(scope.canonical, "skills"),
      boundary: scope.path,
      recursive: true,
      interest: join(scope.canonical, "skills"),
    },
    {
      path: join(scope.canonical, "overlord", "agents"),
      boundary: scope.path,
      recursive: false,
      interest: join(scope.canonical, "overlord", "agents"),
    },
    {
      path: paths.claude.skills,
      boundary: claudeBoundary,
      recursive: true,
      interest: paths.claude.skills,
    },
    {
      path: paths.claude.agents,
      boundary: claudeBoundary,
      recursive: true,
      interest: paths.claude.agents,
    },
    {
      path: paths.codex.agents,
      boundary: codexBoundary,
      recursive: false,
      interest: paths.codex.agents,
    },
  ];
}

/** Resolve the smallest useful physical watcher set for a successful fleet inventory. */
export async function buildWatchTargets(
  document: OutputDocument,
  options: EngineOptions,
): Promise<WatchTarget[]> {
  const desired: DesiredWatch[] = [];
  for (const scope of document.scopes ?? []) desired.push(...scopeWatches(scope, options));

  const canonicalRoot = join(options.home, ".agents");
  const configuration = configPath(canonicalRoot);
  desired.push({
    path: dirname(configuration),
    boundary: canonicalRoot,
    recursive: false,
    interest: configuration,
  });

  const configured = await loadConfig(canonicalRoot, options.home);
  for (const root of configured.roots) {
    desired.push({ path: root, boundary: root, recursive: false, interest: root });
  }

  const grouped = new Map<string, { path: string; recursive: boolean; interests: Set<string> }>();
  for (const item of desired) {
    const anchor = await nearestPhysicalDirectory(item.path, item.boundary);
    if (anchor === undefined) continue;
    const key = normalizedPath(anchor);
    const current = grouped.get(key) ?? { path: anchor, recursive: false, interests: new Set<string>() };
    current.recursive ||= item.recursive && normalizedPath(anchor) === normalizedPath(item.path);
    current.interests.add(resolve(item.interest));
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .map((target): WatchTarget => ({
      path: target.path,
      recursive: target.recursive,
      interests: [...target.interests].sort(compareText),
    }))
    .sort((left, right) => compareText(left.path, right.path));
}

function targetKey(target: WatchTarget): string {
  return JSON.stringify([normalizedPath(target.path), target.recursive, target.interests]);
}

function relevantEvent(target: WatchTarget, filename: string | null): boolean {
  if (filename === null) return true;
  const changed = resolve(target.path, filename);
  return target.interests.some((interest) => pathsRelated(changed, interest));
}

function plannedRemovalKeys(document: OutputDocument): Set<string> {
  const keys = new Set<string>();
  for (const action of document.actions ?? []) {
    if (action.status !== "planned") continue;
    const key = removalApprovalKey(action);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

function hasLockContention(document: OutputDocument): boolean {
  return document.diagnostics?.some((entry) => entry.code === "lock-held") ?? false;
}

/**
 * Synchronize a fleet until the supplied signal is aborted.
 *
 * Filesystem events are only invalidation hints. Every cycle performs full
 * discovery and locked inventory through the normal synchronization engine.
 */
export async function watchFleet(options: WatchFleetOptions): Promise<void> {
  if (options.signal.aborted) return;

  const synchronize = options.synchronize ?? synchronizeFleet;
  const watchFactory = options.watchFactory ?? realWatchFactory;
  const timers = options.timers ?? defaultTimers;
  const debounceMs = positiveDuration(options.debounceMs, WATCH_DEBOUNCE_MS, true);
  const scanIntervalMs = positiveDuration(options.scanIntervalMs, WATCH_SCAN_INTERVAL_MS, true);
  const removalGraceMs = positiveDuration(options.removalGraceMs, WATCH_REMOVAL_GRACE_MS, true);
  const retryInitialMs = positiveDuration(options.retryInitialMs, WATCH_RETRY_INITIAL_MS);
  const retryMaxMs = Math.max(
    retryInitialMs,
    positiveDuration(options.retryMaxMs, WATCH_RETRY_MAX_MS),
  );
  const report = options.onReport ?? (() => undefined);

  let activeWatches = new Map<string, ActiveWatch>();
  let removalCandidates = new Map<string, RemovalCandidate>();
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let immediateTimer: ReturnType<typeof setTimeout> | undefined;
  let removalTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let periodicTimer: ReturnType<typeof setInterval> | undefined;
  let retryDelayMs = retryInitialMs;
  let retryDueAt: number | undefined;
  let running = false;
  let dirty = false;
  let stopped = false;
  let started = false;
  let activeCycle: Promise<void> | undefined;
  const pendingReasons = new Set<string>();

  let resolveAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolveAbortPromise) => {
    resolveAbort = resolveAbortPromise;
  });

  function clearEventTimer(): void {
    if (eventTimer === undefined) return;
    timers.clearTimeout(eventTimer);
    eventTimer = undefined;
  }

  function clearImmediateTimer(): void {
    if (immediateTimer === undefined) return;
    timers.clearTimeout(immediateTimer);
    immediateTimer = undefined;
  }

  function clearRemovalTimer(): void {
    if (removalTimer === undefined) return;
    timers.clearTimeout(removalTimer);
    removalTimer = undefined;
  }

  function clearRetryTimer(resetDelay: boolean): void {
    if (retryTimer !== undefined) timers.clearTimeout(retryTimer);
    retryTimer = undefined;
    retryDueAt = undefined;
    if (resetDelay) retryDelayMs = retryInitialMs;
  }

  function closeWatch(entry: ActiveWatch): void {
    try {
      entry.handle.close();
    } catch {
      // Closing is best effort; all scheduling state is already detached.
    }
  }

  function closeAllWatches(): void {
    const current = activeWatches;
    activeWatches = new Map();
    for (const entry of current.values()) closeWatch(entry);
  }

  function stop(): void {
    if (!stopped) {
      stopped = true;
      clearEventTimer();
      clearImmediateTimer();
      clearRemovalTimer();
      clearRetryTimer(false);
      if (periodicTimer !== undefined) timers.clearInterval(periodicTimer);
      periodicTimer = undefined;
      resolveAbort?.();
    }
    closeAllWatches();
  }

  const abortListener = () => stop();
  options.signal.addEventListener("abort", abortListener, { once: true });
  if (options.signal.aborted) stop();

  function watchedPaths(): string[] {
    return [...activeWatches.values()]
      .map((entry) => entry.target.path)
      .sort(compareText);
  }

  function retryRemaining(): number {
    return retryDueAt === undefined ? retryDelayMs : Math.max(0, retryDueAt - timers.now());
  }

  function requestImmediate(reason: string): void {
    if (stopped) return;
    pendingReasons.add(reason);
    if (running) {
      dirty = true;
      return;
    }
    clearEventTimer();
    if (immediateTimer !== undefined) return;
    immediateTimer = timers.setTimeout(() => {
      immediateTimer = undefined;
      launchCycle();
    }, 0);
  }

  function requestEvent(reason: string): void {
    if (stopped) return;
    pendingReasons.add(reason);
    if (running) {
      dirty = true;
      return;
    }
    if (immediateTimer !== undefined) return;
    clearEventTimer();
    eventTimer = timers.setTimeout(() => {
      eventTimer = undefined;
      launchCycle();
    }, debounceMs);
  }

  function scheduleRetry(reason: string): number {
    if (stopped) return 0;
    if (retryTimer !== undefined) return retryRemaining();
    const delay = retryDelayMs;
    retryDueAt = timers.now() + delay;
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      retryDueAt = undefined;
      requestImmediate(reason);
    }, delay);
    retryDelayMs = Math.min(retryMaxMs, retryDelayMs * 2);
    return delay;
  }

  function reportWatchError(error: unknown, schedule = true): void {
    const delay = schedule ? scheduleRetry("watch-retry") : retryRemaining();
    report({ type: "error", phase: "watch", error, retryInMs: delay });
  }

  function handleWatchError(key: string, token: object, error: unknown): void {
    const current = activeWatches.get(key);
    if (current === undefined || current.token !== token) return;
    activeWatches.delete(key);
    closeWatch(current);
    reportWatchError(error);
  }

  async function replaceWatches(document: OutputDocument): Promise<boolean> {
    const targets = await buildWatchTargets(document, options.engine);
    if (stopped) return false;
    const previous = activeWatches;
    const next = new Map<string, ActiveWatch>();
    let failed = false;

    for (const target of targets) {
      if (stopped) break;
      const key = targetKey(target);
      const token = {};
      try {
        const handle = watchFactory(target, {
          change(eventType, filename) {
            if (!relevantEvent(target, filename)) return;
            requestEvent(`filesystem:${eventType}:${target.path}`);
          },
          error(error) {
            handleWatchError(key, token, error);
          },
        });
        const entry = { target, handle, token };
        if (stopped) closeWatch(entry);
        else next.set(key, entry);
      } catch (error) {
        failed = true;
        const retained = previous.get(key);
        if (retained !== undefined) next.set(key, retained);
        reportWatchError(error, false);
      }
    }

    if (stopped) {
      for (const entry of next.values()) closeWatch(entry);
      return false;
    }
    activeWatches = next;
    for (const [key, entry] of previous) {
      if (next.get(key) !== entry) closeWatch(entry);
    }
    return failed;
  }

  function approvedRemovalActions(): Set<string> {
    const now = timers.now();
    const approved = new Set<string>();
    for (const [key, candidate] of removalCandidates) {
      if (now - candidate.firstSeenAt >= removalGraceMs) approved.add(key);
    }
    return approved;
  }

  function scheduleRemovalCheck(): void {
    clearRemovalTimer();
    if (stopped) return;
    let earliest: number | undefined;
    for (const candidate of removalCandidates.values()) {
      if (candidate.graceTriggered) continue;
      const dueAt = candidate.firstSeenAt + removalGraceMs;
      if (earliest === undefined || dueAt < earliest) earliest = dueAt;
    }
    if (earliest === undefined) return;
    removalTimer = timers.setTimeout(() => {
      removalTimer = undefined;
      const now = timers.now();
      let ready = false;
      for (const candidate of removalCandidates.values()) {
        if (!candidate.graceTriggered && candidate.firstSeenAt + removalGraceMs <= now) {
          candidate.graceTriggered = true;
          ready = true;
        }
      }
      if (ready) requestImmediate("removal-grace");
      scheduleRemovalCheck();
    }, Math.max(0, earliest - timers.now()));
  }

  function updateRemovalCandidates(document: OutputDocument): void {
    const observed = plannedRemovalKeys(document);
    const next = new Map<string, RemovalCandidate>();
    const now = timers.now();
    for (const key of observed) {
      next.set(key, removalCandidates.get(key) ?? { firstSeenAt: now, graceTriggered: false });
    }
    removalCandidates = next;
    scheduleRemovalCheck();
  }

  async function runCycle(reasons: readonly string[], initial: boolean): Promise<void> {
    const document = await synchronize(options.engine, {
      approvedRemovalActions: approvedRemovalActions(),
    });
    if (stopped) return;

    updateRemovalCandidates(document);
    let watchFailure = false;
    try {
      watchFailure = await replaceWatches(document);
    } catch (error) {
      if (stopped) return;
      watchFailure = true;
      reportWatchError(error, false);
    }
    if (stopped) return;

    const retryNeeded = watchFailure || hasLockContention(document);
    if (retryNeeded) scheduleRetry(hasLockContention(document) ? "lock-retry" : "watch-retry");
    else clearRetryTimer(true);

    report({
      type: initial ? "started" : "cycle",
      document,
      reasons,
      watchedPaths: watchedPaths(),
      pendingRemovals: removalCandidates.size,
    });
  }

  function launchCycle(): void {
    if (stopped || running) return;
    clearEventTimer();
    clearImmediateTimer();
    const reasons = pendingReasons.size > 0 ? [...pendingReasons].sort(compareText) : ["rescan"];
    pendingReasons.clear();
    dirty = false;
    running = true;

    const cycle = (async () => {
      try {
        await runCycle(reasons, false);
      } catch (error) {
        const delay = scheduleRetry("sync-retry");
        report({ type: "error", phase: "sync", error, retryInMs: delay });
      }
    })();
    activeCycle = cycle;
    void cycle.then(() => {
      if (activeCycle === cycle) activeCycle = undefined;
      running = false;
      if (!stopped && (dirty || pendingReasons.size > 0)) requestImmediate("changes-during-cycle");
    });
  }

  try {
    if (stopped) return;
    running = true;
    try {
      await runCycle(["startup"], true);
      started = !stopped;
    } finally {
      running = false;
    }

    if (!stopped && (dirty || pendingReasons.size > 0)) requestImmediate("changes-during-cycle");
    if (!stopped && scanIntervalMs > 0) {
      periodicTimer = timers.setInterval(() => requestImmediate("periodic-scan"), scanIntervalMs);
    }
    if (!stopped) await aborted;
    const finalCycle = activeCycle;
    if (finalCycle !== undefined) await finalCycle;
  } finally {
    stop();
    options.signal.removeEventListener("abort", abortListener);
    if (started) report({ type: "stopped" });
  }
}
