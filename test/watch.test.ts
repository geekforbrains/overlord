import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type { SynchronizeOptions } from "../src/engine.js";
import { removalApprovalKey } from "../src/removals.js";
import {
  watchFleet,
  type WatchCallbacks,
  type WatchFactory,
  type WatchReport,
  type WatchTarget,
} from "../src/watch.js";
import type { ActionRecord, EngineOptions, OutputDocument, Scope } from "../src/types.js";
import {
  cleanupTemporaryDirectories,
  prepareUserRepository,
  temporaryDirectory,
  validSkill,
  writeText,
} from "./helpers.js";

afterEach(async () => {
  vi.useRealTimers();
  await cleanupTemporaryDirectories();
});

interface CapturedWatch {
  target: WatchTarget;
  callbacks: WatchCallbacks;
  close: Mock<() => void>;
}

type SynchronizeFunction = (
  engine: EngineOptions,
  synchronizeOptions?: SynchronizeOptions,
) => Promise<OutputDocument>;

function captureWatchFactory(): {
  factory: WatchFactory;
  watches: CapturedWatch[];
  active(): CapturedWatch[];
} {
  const watches: CapturedWatch[] = [];
  const factory: WatchFactory = (target, callbacks) => {
    const close = vi.fn<() => void>();
    watches.push({ target, callbacks, close });
    return { close };
  };
  return {
    factory,
    watches,
    active: () => watches.filter((entry) => entry.close.mock.calls.length === 0),
  };
}

function outputDocument(scopes: Scope[], actions: ActionRecord[] = []): OutputDocument {
  return {
    schemaVersion: 2,
    command: "sync",
    status: "ok",
    scopes,
    definitions: [],
    summary: { total: 0, byState: {}, managed: 0 },
    actions,
    diagnostics: [],
  };
}

async function userFixture(createArtifactRoots = true): Promise<{
  home: string;
  engine: EngineOptions;
  scope: Scope;
  document: OutputDocument;
}> {
  const home = await temporaryDirectory();
  const engine: EngineOptions = {
    home,
    env: {
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
    },
  };
  await writeText(join(home, ".agents/overlord/overlord.yaml"), "roots: []\n");
  if (createArtifactRoots) {
    await Promise.all([
      mkdir(join(home, ".agents/skills"), { recursive: true }),
      mkdir(join(home, ".agents/overlord/agents"), { recursive: true }),
      mkdir(join(home, ".claude/skills"), { recursive: true }),
      mkdir(join(home, ".claude/agents"), { recursive: true }),
      mkdir(join(home, ".codex/agents"), { recursive: true }),
    ]);
  }
  const scope: Scope = { type: "user", path: home, canonical: join(home, ".agents") };
  return { home, engine, scope, document: outputDocument([scope]) };
}

function canonicalSkillWatch(watches: CapturedWatch[], home: string): CapturedWatch {
  const path = resolve(home, ".agents/skills");
  const entry = watches.find((candidate) => resolve(candidate.target.path) === path);
  if (entry === undefined) throw new Error(`No captured watch for ${path}`);
  return entry;
}

async function waitForReport(
  reports: readonly WatchReport[],
  type: WatchReport["type"],
  count = 1,
): Promise<void> {
  await vi.waitFor(() => {
    expect(reports.filter((report) => report.type === type)).toHaveLength(count);
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let accept: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, reject) => {
    accept = resolvePromise;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) { accept?.(value); },
    reject(error) { rejectPromise?.(error); },
  };
}

describe("watch scheduler", () => {
  it("synchronizes at startup and debounces a burst into one cycle", async () => {
    vi.useFakeTimers();
    const fixture = await userFixture();
    const controller = new AbortController();
    const captured = captureWatchFactory();
    const reports: WatchReport[] = [];
    const synchronize = vi.fn<SynchronizeFunction>(async () => fixture.document);

    const watching = watchFleet({
      engine: fixture.engine,
      signal: controller.signal,
      synchronize,
      watchFactory: captured.factory,
      scanIntervalMs: 0,
      onReport: (report) => reports.push(report),
    });
    await waitForReport(reports, "started");

    expect(synchronize).toHaveBeenCalledTimes(1);
    const watchedSkill = canonicalSkillWatch(captured.active(), fixture.home);
    watchedSkill.callbacks.change("change", "verify-build/SKILL.md");
    await vi.advanceTimersByTimeAsync(300);
    watchedSkill.callbacks.change("rename", "verify-build/SKILL.md");
    await vi.advanceTimersByTimeAsync(300);
    watchedSkill.callbacks.change("change", "verify-build/references/guide.md");

    await vi.advanceTimersByTimeAsync(749);
    expect(synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2));
    await waitForReport(reports, "cycle");

    controller.abort();
    await watching;
    expect(reports.at(-1)).toEqual({ type: "stopped" });
  });

  it("runs exactly one follow-up when events arrive during an in-flight cycle", async () => {
    vi.useFakeTimers();
    const fixture = await userFixture();
    const controller = new AbortController();
    const captured = captureWatchFactory();
    const reports: WatchReport[] = [];
    const inFlight = deferred<OutputDocument>();
    const synchronize = vi.fn<SynchronizeFunction>(() => {
      if (synchronize.mock.calls.length === 2) return inFlight.promise;
      return Promise.resolve(fixture.document);
    });

    const watching = watchFleet({
      engine: fixture.engine,
      signal: controller.signal,
      synchronize,
      watchFactory: captured.factory,
      scanIntervalMs: 0,
      onReport: (report) => reports.push(report),
    });
    await waitForReport(reports, "started");

    const watchedSkill = canonicalSkillWatch(captured.active(), fixture.home);
    watchedSkill.callbacks.change("change", "verify-build/SKILL.md");
    await vi.advanceTimersByTimeAsync(750);
    expect(synchronize).toHaveBeenCalledTimes(2);

    watchedSkill.callbacks.change("change", "verify-build/SKILL.md");
    watchedSkill.callbacks.change("rename", "verify-build/SKILL.md");
    watchedSkill.callbacks.change("change", "verify-build/assets/example.txt");
    inFlight.resolve(fixture.document);
    await waitForReport(reports, "cycle");
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(3));
    await waitForReport(reports, "cycle", 2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(synchronize).toHaveBeenCalledTimes(3);
    controller.abort();
    await watching;
  });

  it("runs a periodic full cycle even without filesystem events", async () => {
    vi.useFakeTimers();
    const fixture = await userFixture();
    const controller = new AbortController();
    const captured = captureWatchFactory();
    const reports: WatchReport[] = [];
    const synchronize = vi.fn<SynchronizeFunction>(async () => fixture.document);

    const watching = watchFleet({
      engine: fixture.engine,
      signal: controller.signal,
      synchronize,
      watchFactory: captured.factory,
      scanIntervalMs: 30_000,
      onReport: (report) => reports.push(report),
    });
    await waitForReport(reports, "started");

    await vi.advanceTimersByTimeAsync(29_000);
    expect(synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2));
    await waitForReport(reports, "cycle");
    expect(reports.find((report) => (
      report.type === "cycle" && report.reasons.includes("periodic-scan")
    ))).toBeDefined();

    controller.abort();
    await watching;
  });

  it("replaces watcher handles after discovery changes and closes all active handles on abort", async () => {
    vi.useFakeTimers();
    const fixture = await userFixture();
    const firstProject = join(fixture.home, "Projects/alpha");
    const secondProject = join(fixture.home, "Projects/bravo");
    await Promise.all([
      mkdir(join(firstProject, ".agents/skills"), { recursive: true }),
      mkdir(join(secondProject, ".agents/skills"), { recursive: true }),
    ]);
    const firstProjectScope: Scope = {
      type: "project",
      path: firstProject,
      canonical: join(firstProject, ".agents"),
      discoveryRoot: join(fixture.home, "Projects"),
    };
    const secondProjectScope: Scope = {
      type: "project",
      path: secondProject,
      canonical: join(secondProject, ".agents"),
      discoveryRoot: join(fixture.home, "Projects"),
    };
    const startupDocument = outputDocument([fixture.scope, firstProjectScope]);
    const replacementDocument = outputDocument([fixture.scope, secondProjectScope]);
    const controller = new AbortController();
    const captured = captureWatchFactory();
    const reports: WatchReport[] = [];
    let synchronizeCalls = 0;
    const synchronize = vi.fn<SynchronizeFunction>(() => {
      synchronizeCalls += 1;
      return Promise.resolve(synchronizeCalls === 1 ? startupDocument : replacementDocument);
    });

    const watching = watchFleet({
      engine: fixture.engine,
      signal: controller.signal,
      synchronize,
      watchFactory: captured.factory,
      scanIntervalMs: 0,
      onReport: (report) => reports.push(report),
    });
    await waitForReport(reports, "started");
    const startupHandles = [...captured.active()];
    const firstProjectHandles = startupHandles.filter((entry) => (
      entry.target.path === firstProject || entry.target.path.startsWith(`${firstProject}/`)
    ));
    expect(firstProjectHandles.length).toBeGreaterThan(0);

    canonicalSkillWatch(startupHandles, fixture.home).callbacks.change(
      "change",
      "verify-build/SKILL.md",
    );
    await vi.advanceTimersByTimeAsync(750);
    await waitForReport(reports, "cycle");

    expect(firstProjectHandles.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);
    const replacementHandles = captured.active();
    expect(replacementHandles.some((entry) => (
      resolve(entry.target.path) === resolve(secondProject, ".agents/skills")
    ))).toBe(true);
    expect(replacementHandles.some((entry) => (
      entry.target.path === firstProject || entry.target.path.startsWith(`${firstProject}/`)
    ))).toBe(false);

    controller.abort();
    await watching;
    expect(replacementHandles.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);
    const completedCycles = synchronize.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(synchronize).toHaveBeenCalledTimes(completedCycles);
    expect(reports.at(-1)).toEqual({ type: "stopped" });
  });

  it("closes a handle created concurrently with startup abort", async () => {
    vi.useFakeTimers();
    const fixture = await userFixture();
    const controller = new AbortController();
    const reports: WatchReport[] = [];
    const close = vi.fn<() => void>();
    let creations = 0;
    const watchFactory: WatchFactory = () => {
      creations += 1;
      if (creations === 1) controller.abort();
      return { close };
    };

    await watchFleet({
      engine: fixture.engine,
      signal: controller.signal,
      synchronize: async () => fixture.document,
      watchFactory,
      scanIntervalMs: 0,
      onReport: (report) => reports.push(report),
    });

    expect(creations).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([]);
  });

  it("retries a failed watcher attachment at the advertised delay", async () => {
    vi.useFakeTimers();
    const fixture = await userFixture();
    const controller = new AbortController();
    const captured = captureWatchFactory();
    const reports: WatchReport[] = [];
    const synchronize = vi.fn<SynchronizeFunction>(async () => fixture.document);
    let attachmentAttempts = 0;
    const watchFactory: WatchFactory = (target, callbacks) => {
      attachmentAttempts += 1;
      if (attachmentAttempts === 1) throw new Error("watch capacity exhausted");
      return captured.factory(target, callbacks);
    };

    const watching = watchFleet({
      engine: fixture.engine,
      signal: controller.signal,
      synchronize,
      watchFactory,
      scanIntervalMs: 0,
      retryInitialMs: 1_000,
      retryMaxMs: 1_000,
      onReport: (report) => reports.push(report),
    });
    await waitForReport(reports, "started");

    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(reports).toContainEqual(expect.objectContaining({
      type: "error",
      phase: "watch",
      retryInMs: 1_000,
    }));
    await vi.advanceTimersToNextTimerAsync();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2));
    await waitForReport(reports, "cycle");
    expect(canonicalSkillWatch(captured.active(), fixture.home)).toBeDefined();

    controller.abort();
    await watching;
  });

  it("approves the same stable removal only after its two-second grace window", async () => {
    vi.useFakeTimers();
    const fixture = await userFixture();
    const controller = new AbortController();
    const captured = captureWatchFactory();
    const reports: WatchReport[] = [];
    const removal: ActionRecord = {
      id: `reconcile-skill-verify-build@${fixture.home}`,
      status: "planned",
      description: "Remove the synchronized skill.",
      scope: "user",
      scopePath: fixture.home,
      reads: [join(fixture.home, ".agents/skills/verify-build")],
      removes: [
        join(fixture.home, ".agents/skills/verify-build"),
        join(fixture.home, ".claude/skills/verify-build"),
      ],
    };
    const removalDocument = outputDocument([fixture.scope], [removal]);
    const settledDocument = outputDocument([fixture.scope]);
    const approvals: Set<string>[] = [];
    const graceStartedAt = Date.now();
    let synchronizeCalls = 0;
    const synchronize = vi.fn<SynchronizeFunction>((
      _engine: EngineOptions,
      synchronizeOptions?: SynchronizeOptions,
    ) => {
      synchronizeCalls += 1;
      approvals.push(new Set(synchronizeOptions?.approvedRemovalActions));
      return Promise.resolve(synchronizeCalls === 1 ? removalDocument : settledDocument);
    });

    const watching = watchFleet({
      engine: fixture.engine,
      signal: controller.signal,
      synchronize,
      watchFactory: captured.factory,
      scanIntervalMs: 0,
      removalGraceMs: 2_000,
      onReport: (report) => reports.push(report),
    });
    await waitForReport(reports, "started");

    const approvalKey = removalApprovalKey(removal);
    expect(approvalKey).toBeDefined();
    expect(approvals[0]).toEqual(new Set());
    expect(reports.find((report) => report.type === "started")).toMatchObject({
      pendingRemovals: 1,
    });

    const graceRemaining = 2_000 - (Date.now() - graceStartedAt);
    await vi.advanceTimersByTimeAsync(graceRemaining - 1);
    expect(synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2));
    expect(approvals[1]).toEqual(new Set([approvalKey]));
    await waitForReport(reports, "cycle");

    controller.abort();
    await watching;
  });

  it("restarts the grace window when a removal action changes", async () => {
    vi.useFakeTimers();
    const fixture = await userFixture();
    const controller = new AbortController();
    const captured = captureWatchFactory();
    const reports: WatchReport[] = [];
    const firstRemoval: ActionRecord = {
      id: `reconcile-skill-first@${fixture.home}`,
      status: "planned",
      description: "Remove the first synchronized skill.",
      scope: "user",
      scopePath: fixture.home,
      removes: [join(fixture.home, ".claude/skills/first")],
    };
    const changedRemoval: ActionRecord = {
      id: `reconcile-skill-second@${fixture.home}`,
      status: "planned",
      description: "Remove a different synchronized skill.",
      scope: "user",
      scopePath: fixture.home,
      removes: [join(fixture.home, ".claude/skills/second")],
    };
    const approvals: Set<string>[] = [];
    let synchronizeCalls = 0;
    let changedObservedAt: number | undefined;
    const synchronize = vi.fn<SynchronizeFunction>((_engine, synchronizeOptions) => {
      approvals.push(new Set(synchronizeOptions?.approvedRemovalActions));
      synchronizeCalls += 1;
      if (synchronizeCalls === 1) return Promise.resolve(outputDocument([fixture.scope], [firstRemoval]));
      if (synchronizeCalls === 2) {
        changedObservedAt = Date.now();
        return Promise.resolve(outputDocument([fixture.scope], [changedRemoval]));
      }
      return Promise.resolve(outputDocument([fixture.scope]));
    });

    const watching = watchFleet({
      engine: fixture.engine,
      signal: controller.signal,
      synchronize,
      watchFactory: captured.factory,
      debounceMs: 0,
      scanIntervalMs: 0,
      removalGraceMs: 2_000,
      onReport: (report) => reports.push(report),
    });
    await waitForReport(reports, "started");

    await vi.advanceTimersByTimeAsync(500);
    canonicalSkillWatch(captured.active(), fixture.home).callbacks.change(
      "change",
      "verify-build/SKILL.md",
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2));
    await waitForReport(reports, "cycle");
    expect(approvals[1]).toEqual(new Set());

    expect(changedObservedAt).toBeDefined();
    const elapsed = Date.now() - (changedObservedAt ?? Date.now());
    await vi.advanceTimersByTimeAsync(Math.max(0, 2_000 - elapsed - 1));
    expect(synchronize).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(3));
    const changedKey = removalApprovalKey(changedRemoval);
    expect(changedKey).toBeDefined();
    expect(approvals[2]).toEqual(new Set(changedKey === undefined ? [] : [changedKey]));

    controller.abort();
    await watching;
  });

  it("ignores unrelated events emitted by a nearest-parent sentinel", async () => {
    vi.useFakeTimers();
    const fixture = await userFixture(false);
    const controller = new AbortController();
    const captured = captureWatchFactory();
    const reports: WatchReport[] = [];
    const synchronize = vi.fn<SynchronizeFunction>(async () => fixture.document);

    const watching = watchFleet({
      engine: fixture.engine,
      signal: controller.signal,
      synchronize,
      watchFactory: captured.factory,
      scanIntervalMs: 0,
      onReport: (report) => reports.push(report),
    });
    await waitForReport(reports, "started");

    const sentinelPath = resolve(fixture.home, ".agents");
    const sentinel = captured.active().find((entry) => resolve(entry.target.path) === sentinelPath);
    expect(sentinel).toBeDefined();
    expect(sentinel?.target.interests).toContain(join(fixture.home, ".agents/skills"));

    sentinel?.callbacks.change("rename", "unrelated-notes.txt");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(synchronize).toHaveBeenCalledTimes(1);

    sentinel?.callbacks.change("rename", "skills");
    await vi.advanceTimersByTimeAsync(750);
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2));
    await waitForReport(reports, "cycle");

    controller.abort();
    await watching;
  });
});

async function eventually(assertion: () => Promise<void>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastFailure = error;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw lastFailure ?? new Error("Timed out waiting for filesystem watcher activity");
}

it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "converges a real canonical edit through filesystem watching or periodic recovery",
  async () => {
    const home = await temporaryDirectory();
    const discoveryRoot = await temporaryDirectory();
    const project = join(discoveryRoot, "app");
    const canonical = join(project, ".agents/skills/verify-build/SKILL.md");
    const native = join(project, ".claude/skills/verify-build/SKILL.md");
    const engine: EngineOptions = {
      home,
      env: {
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
      },
    };
    await writeText(
      join(home, ".agents/overlord/overlord.yaml"),
      `roots:\n  - ${JSON.stringify(discoveryRoot)}\n`,
    );
    await prepareUserRepository(home);
    await writeText(canonical, validSkill);

    const controller = new AbortController();
    const reports: WatchReport[] = [];
    const watching = watchFleet({
      engine,
      signal: controller.signal,
      debounceMs: 25,
      // Real filesystem watchers have no readiness acknowledgement and may
      // drop an invalidation hint under load. Production heals that condition
      // with its periodic scan; keep the integration test faithful while the
      // injected watcher tests above cover exact event scheduling.
      scanIntervalMs: 100,
      onReport: (report) => reports.push(report),
    });

    try {
      await eventually(async () => {
        expect(reports.some((report) => report.type === "started")).toBe(true);
        expect(await readFile(native, "utf8")).toBe(validSkill);
      });

      const changed = validSkill.replace(
        "Run the documented build and report concrete failures.",
        "Run the changed build and report concrete failures.",
      );
      await writeText(canonical, changed);

      await eventually(async () => {
        expect(await readFile(native, "utf8")).toBe(changed);
        expect(reports.some((report) => (
          report.type === "cycle"
          && report.reasons.some((reason) => (
            reason.startsWith("filesystem:") || reason === "periodic-scan"
          ))
        ))).toBe(true);
      });
    } finally {
      controller.abort();
      await watching;
    }
  },
  15_000,
);
