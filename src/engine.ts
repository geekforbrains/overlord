import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { configPath, loadConfig, renderConfig } from "./config.js";
import { loadCanonicalScope } from "./definitions.js";
import { discoverScopes, type DiscoveryResult } from "./discovery.js";
import { commitManagedChanges, ensureUserRepository, requireUserRepository, type ManagedCommit } from "./git.js";
import {
  acquireScopeLock,
  assertNoSymlinkedParent,
  compareDirectories,
  copyDirectoryExclusive,
  pathExists,
  removePhysicalArtifact,
  replaceDirectoryAtomic,
  replaceFileAtomic,
  writeFileAtomicExclusive,
} from "./filesystem.js";
import {
  deleteLedgerEntry,
  digestFile,
  digestSkillTree,
  ledgerPath,
  loadScopeLedger,
  saveScopeLedger,
  setLedgerEntry,
  type LedgerEntry,
  type ScopeLedger,
} from "./ledger.js";
import { scanNative as scanSupportedNative } from "./native.js";
import {
  renderCanonicalAgent,
  renderClaudeAgent,
  renderCodexAgent,
} from "./render.js";
import { removalApprovalKey } from "./removals.js";
import { buildReconciliationPlans, recordForPlan, type ReconciliationPlan } from "./reconciliation.js";
import { resolveTargetPaths, type TargetPaths } from "./targets.js";
import type {
  ActionRecord,
  CanonicalAgent,
  CanonicalScope,
  DefinitionRecord,
  DefinitionState,
  Diagnostic,
  EngineOptions,
  OutputDocument,
  Scope,
  SummaryRecord,
  TargetName,
} from "./types.js";

const FAILING_STATES = new Set<DefinitionState>(["missing", "changed", "conflict", "invalid"]);

interface ScopeContext {
  scope: Scope;
  expectedPhysicalPath: string | undefined;
  scopeIdentity: string;
  paths: TargetPaths;
  ledger: ScopeLedger;
  canonical: CanonicalScope;
  definitions: DefinitionRecord[];
  plans: ReconciliationPlan[];
  diagnostics: Diagnostic[];
  actions: ActionRecord[];
}

interface ProgressCarrier {
  completedActions?: ActionRecord[];
}

export interface SynchronizeOptions {
  /**
   * When present, plans that remove files execute only when their exact action
   * key is included. Omit this policy for ordinary foreground synchronization.
   */
  approvedRemovalActions?: ReadonlySet<string>;
}

function withCompletedActions(error: unknown, actions: ActionRecord[]): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  const carrier = failure as Error & ProgressCarrier;
  const nested = Array.isArray(carrier.completedActions) ? carrier.completedActions : [];
  carrier.completedActions = [...actions, ...nested];
  return failure;
}

function appendFailure(primary: unknown, secondary: unknown, label: string): Error {
  const failure = primary instanceof Error ? primary : new Error(String(primary));
  const detail = secondary instanceof Error ? secondary.message : String(secondary);
  failure.message = `${failure.message}; ${label}: ${detail}`;
  return failure;
}

async function finishLockedOperation(
  release: () => Promise<void>,
  actions: ActionRecord[],
  operationFailure?: unknown,
): Promise<void> {
  let failure = operationFailure;
  try {
    await release();
  } catch (releaseFailure) {
    failure = failure === undefined
      ? releaseFailure
      : appendFailure(failure, releaseFailure, "failed to release the scope lock");
  }
  if (failure !== undefined) throw withCompletedActions(failure, actions);
}

function completedActions(error: unknown): ActionRecord[] {
  if (error === null || typeof error !== "object") return [];
  const value = (error as ProgressCarrier).completedActions;
  return Array.isArray(value) ? value : [];
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function diagnostic(
  severity: Diagnostic["severity"],
  code: string,
  message: string,
  path?: string,
  scopePath?: string,
): Diagnostic {
  const result: Diagnostic = { severity, code, message };
  if (path !== undefined) result.path = path;
  if (scopePath !== undefined) result.scopePath = scopePath;
  return result;
}

function scopeFailure(scope: Scope, error: unknown): Diagnostic {
  const code = errorCode(error) ?? "scope-failed";
  const message = error instanceof Error ? error.message : String(error);
  const record = error !== null && typeof error === "object" ? error as { path?: unknown } : undefined;
  const path = typeof record?.path === "string" ? record.path : scope.path;
  return diagnostic("error", code, `Scope '${scope.path}' could not be processed: ${message}`, path, scope.path);
}

function actionId(scope: Scope, operation: string): string {
  return `${operation}@${scope.path}`;
}

function filesystemComparisonPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "darwin" ? absolute.normalize("NFD").toLowerCase() : absolute;
}

function samePath(left: string, right: string): boolean {
  return filesystemComparisonPath(left) === filesystemComparisonPath(right);
}

function isProperDescendant(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`);
}

async function comparablePath(path: string, cache: Map<string, Promise<string>>): Promise<string> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const pending = comparablePathUncached(path);
  cache.set(path, pending);
  return pending;
}

async function comparablePathUncached(path: string): Promise<string> {
  let current = resolve(path);
  const missingTail: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(current), ...missingTail);
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") return resolve(path);
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missingTail.unshift(basename(current));
      current = parent;
    }
  }
}

async function pathsOverlap(left: string, right: string, cache: Map<string, Promise<string>>): Promise<boolean> {
  let [comparableLeft, comparableRight] = await Promise.all([comparablePath(left, cache), comparablePath(right, cache)]);
  comparableLeft = filesystemComparisonPath(comparableLeft);
  comparableRight = filesystemComparisonPath(comparableRight);
  const contained = (path: string) => path.length === 0 || (path !== ".." && !path.startsWith(`..${sep}`));
  return contained(relative(comparableLeft, comparableRight)) || contained(relative(comparableRight, comparableLeft));
}

async function assertScopeIdentity(scope: Scope, expectedPhysicalPath: string | undefined): Promise<void> {
  if (expectedPhysicalPath === undefined) return;
  try {
    const metadata = await lstat(scope.path);
    if (!metadata.isDirectory() && !(scope.type === "user" && metadata.isSymbolicLink())) {
      throw new Error("not a directory");
    }
    if (scope.type === "project" && metadata.isSymbolicLink()) throw new Error("not a physical directory");
    const currentPhysicalPath = await realpath(scope.path);
    if (!(await lstat(currentPhysicalPath)).isDirectory()) throw new Error("not a directory");
    if (currentPhysicalPath !== expectedPhysicalPath) throw new Error(`physical path changed to '${currentPhysicalPath}'`);
  } catch (error) {
    throw Object.assign(new Error(`Scope identity changed after discovery: ${scope.path} (${error instanceof Error ? error.message : String(error)})`), {
      code: "permission-denied",
      path: scope.path,
    });
  }
}

function expectedBoundaryIdentity(
  scope: Scope,
  boundary: string,
  expectedPhysicalPath: string | undefined,
): string | undefined {
  return scope.type === "user" && samePath(boundary, scope.path) ? expectedPhysicalPath : undefined;
}

async function assertContextParent(context: ScopeContext, destination: string, boundary: string): Promise<void> {
  await assertNoSymlinkedParent(
    destination,
    boundary,
    expectedBoundaryIdentity(context.scope, boundary, context.expectedPhysicalPath),
  );
}

function summarize(definitions: readonly DefinitionRecord[]): SummaryRecord {
  const byState: SummaryRecord["byState"] = {};
  for (const definition of definitions) byState[definition.state] = (byState[definition.state] ?? 0) + 1;
  return {
    total: definitions.length,
    byState,
    managed: definitions.filter((entry) => entry.canonical !== null).length,
  };
}

function reconciliationAction(
  context: ScopeContext,
  plan: ReconciliationPlan,
  status: ActionRecord["status"],
  phase: "all" | "canonical" | "providers" = "all",
): ActionRecord | undefined {
  const writes: string[] = [];
  const removes: string[] = [];
  if (phase !== "providers") {
    if (plan.canonicalOperation === "write") writes.push(plan.canonicalPath);
    if (plan.canonicalOperation === "remove") removes.push(plan.canonicalPath);
  }
  if (phase !== "canonical") {
    for (const operation of plan.providerOperations) {
      (operation.operation === "write" ? writes : removes).push(operation.path);
    }
  }
  if (writes.length === 0 && removes.length === 0) return undefined;
  const reads = plan.sourcePath !== undefined
    ? [plan.sourcePath]
    : plan.sides.canonical.present
      ? [plan.canonicalPath]
      : [];
  const action: ActionRecord = {
    id: actionId(context.scope, `reconcile-${plan.kind}-${plan.name}`),
    status,
    description: `Reconcile ${plan.kind} '${plan.name}' from ${plan.source}.`,
    scope: context.scope.type,
    scopePath: context.scope.path,
    reads,
  };
  if (writes.length > 0) action.writes = writes;
  if (removes.length > 0) action.removes = removes;
  return action;
}

function approvedPlans(
  context: ScopeContext,
  options: SynchronizeOptions,
): ReconciliationPlan[] {
  const approved = options.approvedRemovalActions;
  if (approved === undefined) return context.plans;
  return context.plans.filter((plan) => {
    const action = reconciliationAction(context, plan, "planned");
    if (action === undefined) return true;
    const key = removalApprovalKey(action);
    return key === undefined || approved.has(key);
  });
}

async function inventoryScope(
  scope: Scope,
  options: EngineOptions,
  expectedPhysicalPath: string | undefined,
): Promise<ScopeContext> {
  const paths = resolveTargetPaths(scope, options);
  const claudeBoundary = nativeBoundaryFor(scope, paths, "claude");
  const expectedClaudeBoundary = expectedBoundaryIdentity(scope, claudeBoundary, expectedPhysicalPath);
  await assertNoSymlinkedParent(join(paths.claude.skills, ".overlord-inventory"), claudeBoundary, expectedClaudeBoundary);
  await assertNoSymlinkedParent(join(paths.claude.agents, ".overlord-inventory"), claudeBoundary, expectedClaudeBoundary);
  const codexBoundary = nativeBoundaryFor(scope, paths, "codex");
  await assertNoSymlinkedParent(
    join(paths.codex.agents, ".overlord-inventory"),
    codexBoundary,
    expectedBoundaryIdentity(scope, codexBoundary, expectedPhysicalPath),
  );
  const canonical = await loadCanonicalScope(scope.canonical);
  const diagnostics = canonical.diagnostics.map((entry): Diagnostic => ({ ...entry, scopePath: scope.path }));
  const native = await scanSupportedNative(paths);
  const scopeIdentity = expectedPhysicalPath ?? await realpath(scope.path);
  const ledger = await loadScopeLedger(join(options.home, ".agents"), scopeIdentity);
  const plans = await buildReconciliationPlans({ scope, paths, canonical, native, ledger });
  const records = plans.map((plan) => recordForPlan(scope, plan));
  const context: ScopeContext = {
    scope,
    expectedPhysicalPath,
    scopeIdentity,
    paths,
    ledger,
    canonical,
    definitions: records,
    plans,
    diagnostics,
    actions: [],
  };
  if (!blocksMutation(context)) {
    context.actions = plans.flatMap((plan) => {
      const action = reconciliationAction(context, plan, "planned");
      return action === undefined ? [] : [action];
    });
  }
  return context;
}

async function fleetDiscovery(options: EngineOptions): Promise<DiscoveryResult> {
  const canonicalRoot = join(options.home, ".agents");
  await requireUserRepository(canonicalRoot);
  const config = await loadConfig(canonicalRoot, options.home);
  const discovery = await discoverScopes({ home: options.home, roots: config.roots });
  const comparablePaths = new Map<string, Promise<string>>();
  const userScope = discovery.scopes[0]!;
  const userPaths = resolveTargetPaths(userScope, options);
  const userArtifactRoots = [
    { name: "Claude", path: userPaths.claude.skills },
    { name: "Claude", path: userPaths.claude.agents },
    { name: "Codex", path: userPaths.codex.agents },
  ];
  const overlapOwners = new Map<string, { names: Set<string>; paths: Set<string> }>();
  for (const artifactRoot of userArtifactRoots) {
    for (const root of config.roots) {
      const [comparableRoot, comparableArtifactRoot] = await Promise.all([
        comparablePath(root, comparablePaths),
        comparablePath(artifactRoot.path, comparablePaths),
      ]);
      if (!isProperDescendant(comparableRoot, comparableArtifactRoot)) continue;
      const segments = relative(comparableRoot, comparableArtifactRoot).split(sep);
      const controlIndex = segments.findIndex((segment) => {
        const folded = segment.toLowerCase();
        return folded === ".agents" || folded === ".claude" || folded === ".codex";
      });
      if (controlIndex <= 0) continue;
      const owner = join(root, ...segments.slice(0, controlIndex));
      if (await comparablePath(owner, comparablePaths) === await comparablePath(userScope.path, comparablePaths)) continue;
      const overlap = overlapOwners.get(owner) ?? { names: new Set<string>(), paths: new Set<string>() };
      overlap.names.add(artifactRoot.name);
      overlap.paths.add(artifactRoot.path);
      overlapOwners.set(owner, overlap);
    }
  }
  for (const [owner, overlap] of overlapOwners) {
    const names = [...overlap.names].join(" and ");
    const paths = [...overlap.paths].join(", ");
    const message = `${names} user paths '${paths}' overlap project scope '${owner}' below a discovery root.`;
    discovery.diagnostics.push(diagnostic(
      "error",
      "user-target-overlaps-project",
      message,
      [...overlap.paths][0],
      userScope.path,
    ));
    const project = discovery.scopes.find((scope) => scope.type === "project" && samePath(scope.path, owner));
    if (project !== undefined) {
      discovery.diagnostics.push(diagnostic(
        "error",
        "user-target-overlaps-project",
        message,
        [...overlap.paths][0],
        project.path,
      ));
    }
  }
  for (const scope of discovery.scopes) {
    const paths = resolveTargetPaths(scope, options);
    const providerRoots = [
      { label: "Claude root", path: dirname(paths.claude.skills) },
      { label: "Codex root", path: dirname(paths.codex.agents) },
    ];
    for (const providerRoot of providerRoots) {
      if (await pathsOverlap(scope.canonical, providerRoot.path, comparablePaths)) {
        discovery.diagnostics.push(diagnostic(
          "error",
          "artifact-root-overlap",
          `canonical root '${scope.canonical}' overlaps ${providerRoot.label} '${providerRoot.path}'.`,
          providerRoot.path,
          scope.path,
        ));
      }
    }
    if (await pathsOverlap(providerRoots[0]!.path, providerRoots[1]!.path, comparablePaths)) {
      discovery.diagnostics.push(diagnostic(
        "error",
        "artifact-root-overlap",
        `${providerRoots[0]!.label} '${providerRoots[0]!.path}' overlaps ${providerRoots[1]!.label} '${providerRoots[1]!.path}'.`,
        providerRoots[0]!.path,
        scope.path,
      ));
    }
    const artifactRoots = [
      { label: "canonical skills", path: join(scope.canonical, "skills") },
      { label: "canonical agents", path: join(scope.canonical, "overlord", "agents") },
      { label: "Claude skills", path: paths.claude.skills },
      { label: "Claude agents", path: paths.claude.agents },
      { label: "Codex agents", path: paths.codex.agents },
    ];
    let overlap: { left: typeof artifactRoots[number]; right: typeof artifactRoots[number] } | undefined;
    for (let leftIndex = 0; leftIndex < artifactRoots.length && overlap === undefined; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < artifactRoots.length; rightIndex += 1) {
        const left = artifactRoots[leftIndex]!;
        const right = artifactRoots[rightIndex]!;
        if (await pathsOverlap(left.path, right.path, comparablePaths)) overlap = { left, right };
      }
    }
    if (overlap !== undefined) {
      discovery.diagnostics.push(diagnostic(
        "error",
        "artifact-root-overlap",
        `${overlap.left.label} '${overlap.left.path}' overlaps ${overlap.right.label} '${overlap.right.path}'.`,
        overlap.left.path,
        scope.path,
      ));
    }
  }
  const scopeRoots = discovery.scopes.map((scope) => {
    const paths = resolveTargetPaths(scope, options);
    return {
      scope,
      roots: [
        join(scope.canonical, "skills"),
        join(scope.canonical, "overlord", "agents"),
        paths.claude.skills,
        paths.claude.agents,
        paths.codex.agents,
      ],
    };
  });
  for (let leftIndex = 0; leftIndex < scopeRoots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < scopeRoots.length; rightIndex += 1) {
      const left = scopeRoots[leftIndex]!;
      const right = scopeRoots[rightIndex]!;
      let overlapPath: string | undefined;
      for (const leftPath of left.roots) {
        for (const rightPath of right.roots) {
          if (await pathsOverlap(leftPath, rightPath, comparablePaths)) overlapPath ??= leftPath;
        }
      }
      if (overlapPath === undefined) continue;
      const message = `Artifact roots for '${left.scope.path}' and '${right.scope.path}' overlap.`;
      discovery.diagnostics.push(diagnostic("error", "cross-scope-artifact-overlap", message, overlapPath, left.scope.path));
      discovery.diagnostics.push(diagnostic("error", "cross-scope-artifact-overlap", message, overlapPath, right.scope.path));
    }
  }
  return discovery;
}

async function fleetDocument(
  options: EngineOptions,
  command: OutputDocument["command"],
  discovery?: DiscoveryResult,
): Promise<OutputDocument> {
  const started = performance.now();
  const resolvedDiscovery = discovery ?? await fleetDiscovery(options);
  const definitions: DefinitionRecord[] = [];
  const diagnostics = [...resolvedDiscovery.diagnostics];
  const actions: ActionRecord[] = [];
  for (const scope of resolvedDiscovery.scopes) {
    try {
      const expectedPhysicalPath = resolvedDiscovery.physicalPaths.get(scope.path);
      await assertScopeIdentity(scope, expectedPhysicalPath);
      const context = await inventoryScope(scope, options, expectedPhysicalPath);
      definitions.push(...context.definitions);
      diagnostics.push(...context.diagnostics);
      const blockedByDiscovery = resolvedDiscovery.diagnostics.some(
        (entry) => entry.scopePath === scope.path && entry.severity === "error",
      );
      if (!blockedByDiscovery) actions.push(...context.actions);
    } catch (error) {
      diagnostics.push(scopeFailure(scope, error));
    }
  }
  const attention = definitions.some((entry) => FAILING_STATES.has(entry.state))
    || diagnostics.some((entry) => entry.severity === "error");
  return {
    schemaVersion: 2,
    command,
    status: attention ? "attention-required" : "ok",
    scopes: resolvedDiscovery.scopes,
    definitions,
    summary: summarize(definitions),
    actions,
    diagnostics,
    timing: { totalMs: performance.now() - started },
  };
}

export async function inspect(options: EngineOptions): Promise<OutputDocument> {
  return fleetDocument(options, "status");
}

function nativeBoundaryFor(scope: Scope, paths: TargetPaths, target: TargetName): string {
  if (scope.type === "project") return scope.path;
  const nativeRoot = target === "claude" ? dirname(paths.claude.skills) : dirname(paths.codex.agents);
  return dirname(nativeRoot);
}

function nativeBoundary(context: ScopeContext, target: TargetName): string {
  return nativeBoundaryFor(context.scope, context.paths, target);
}

function blocksMutation(context: ScopeContext): boolean {
  return context.diagnostics.some((entry) => entry.severity === "error")
    || context.canonical.skills.some((entry) => !entry.valid)
    || context.canonical.agents.some((entry) => !entry.valid)
    || context.plans.some((plan) => plan.state === "invalid" && plan.sides.canonical.present);
}

async function writeCanonicalFromPlan(context: ScopeContext, plan: ReconciliationPlan): Promise<void> {
  await assertContextParent(context, plan.canonicalPath, context.scope.path);
  if (plan.kind === "skill") {
    if (plan.sourcePath === undefined) throw new Error(`Skill '${plan.name}' has no provider source to import.`);
    if (await pathExists(plan.canonicalPath)) await replaceDirectoryAtomic(plan.sourcePath, plan.canonicalPath);
    else await copyDirectoryExclusive(plan.sourcePath, plan.canonicalPath);
    return;
  }
  if (plan.desiredAgent === undefined) throw new Error(`Agent '${plan.name}' has no provider source to import.`);
  const source = renderCanonicalAgent({ ...plan.desiredAgent, path: plan.canonicalPath });
  if (await pathExists(plan.canonicalPath)) await replaceFileAtomic(plan.canonicalPath, source);
  else await writeFileAtomicExclusive(plan.canonicalPath, source);
}

async function removeCanonicalFromPlan(context: ScopeContext, plan: ReconciliationPlan): Promise<void> {
  await assertContextParent(context, plan.canonicalPath, context.scope.path);
  await removePhysicalArtifact(plan.canonicalPath, plan.kind === "skill" ? "directory" : "file");
}

async function canonicalAgentAfterMutation(context: ScopeContext, plan: ReconciliationPlan): Promise<CanonicalAgent> {
  if (plan.desiredAgent !== undefined) return { ...plan.desiredAgent, path: plan.canonicalPath };
  const canonical = plan.canonical;
  if (canonical !== undefined && plan.kind === "agent") return canonical as CanonicalAgent;
  const reloaded = await loadCanonicalScope(context.scope.canonical);
  const agent = reloaded.agents.find((entry) => entry.name === plan.name);
  if (agent === undefined || !agent.valid) throw new Error(`Canonical agent '${plan.name}' is unavailable after reconciliation.`);
  return agent;
}

async function executeProviderOperation(
  context: ScopeContext,
  plan: ReconciliationPlan,
  operation: ReconciliationPlan["providerOperations"][number],
): Promise<void> {
  const boundary = nativeBoundary(context, operation.target);
  await assertContextParent(context, operation.path, boundary);
  if (operation.operation === "remove") {
    await removePhysicalArtifact(operation.path, plan.kind === "skill" ? "directory" : "file");
    return;
  }
  if (plan.kind === "skill") {
    if (await pathExists(operation.path)) await replaceDirectoryAtomic(plan.canonicalPath, operation.path);
    else await copyDirectoryExclusive(plan.canonicalPath, operation.path);
    return;
  }
  const agent = await canonicalAgentAfterMutation(context, plan);
  const rendered = operation.target === "claude" ? renderClaudeAgent(agent) : renderCodexAgent(agent);
  if (await pathExists(operation.path)) await replaceFileAtomic(operation.path, rendered);
  else await writeFileAtomicExclusive(operation.path, rendered);
}

function userCanonicalRoot(options: EngineOptions): string {
  return join(options.home, ".agents");
}

async function persistConvergedPlan(
  context: ScopeContext,
  plan: ReconciliationPlan,
  options: EngineOptions,
): Promise<void> {
  const ledgerKey = { scopeIdentity: context.scopeIdentity, kind: plan.kind, name: plan.name } as const;
  if (plan.source === "delete") {
    deleteLedgerEntry(context.ledger, ledgerKey);
    await saveScopeLedger(userCanonicalRoot(options), context.ledger);
    return;
  }
  if (!(await pathExists(plan.canonicalPath))) return;
  const receipts: LedgerEntry["receipts"] = {
    canonical: {
      path: plan.canonicalPath,
      digest: await (plan.kind === "skill" ? digestSkillTree(plan.canonicalPath) : digestFile(plan.canonicalPath)),
    },
  };
  if (plan.kind === "skill") {
    const claudePath = plan.sides.claude.path;
    if (!(await pathExists(claudePath)) || !(await compareDirectories(plan.canonicalPath, claudePath)).equal) return;
    receipts.claude = { path: claudePath, digest: await digestSkillTree(claudePath) };
    setLedgerEntry(context.ledger, ledgerKey, { receipts });
  } else {
    const agent = await canonicalAgentAfterMutation(context, plan);
    for (const target of ["claude", "codex"] as const) {
      if (agent.targets[target] === false) continue;
      const path = plan.sides[target].path;
      if (!(await pathExists(path))) return;
      const expected = target === "claude" ? renderClaudeAgent(agent) : renderCodexAgent(agent);
      if (await readFile(path, "utf8") !== expected) return;
      receipts[target] = { path, digest: await digestFile(path) };
    }
    setLedgerEntry(context.ledger, ledgerKey, {
      receipts,
      canonicalSource: await readFile(plan.canonicalPath, "utf8"),
    });
  }
  await saveScopeLedger(userCanonicalRoot(options), context.ledger);
}

async function executeReconciliationPlan(
  context: ScopeContext,
  plan: ReconciliationPlan,
  options: EngineOptions,
): Promise<ActionRecord | undefined> {
  if (plan.source === "invalid" || (plan.source === "conflict" && plan.providerOperations.length === 0)) return undefined;
  if (plan.canonicalOperation === "write") await writeCanonicalFromPlan(context, plan);
  else if (plan.canonicalOperation === "remove") await removeCanonicalFromPlan(context, plan);
  for (const operation of plan.providerOperations) await executeProviderOperation(context, plan, operation);
  if (plan.source !== "conflict" && requiresLedgerPersistence(plan)) {
    await persistConvergedPlan(context, plan, options);
  }
  return reconciliationAction(context, plan, "completed");
}

function requiresLedgerPersistence(plan: ReconciliationPlan): boolean {
  return plan.source === "delete"
    || plan.canRecordBaseline
    || plan.canonicalOperation !== "none"
    || plan.providerOperations.length > 0;
}

function changesUserCanonical(plan: ReconciliationPlan): boolean {
  return plan.canonicalOperation !== "none"
    || plan.sides.canonical.delta === "added"
    || plan.sides.canonical.delta === "modified"
    || plan.sides.canonical.delta === "deleted";
}

function changeOrigins(plan: ReconciliationPlan): string[] {
  return Object.values(plan.sides)
    .filter((side) => side.delta === "added" || side.delta === "modified" || side.delta === "deleted")
    .map((side) => side.path);
}

function commitAction(scope: Scope, commit: ManagedCommit): ActionRecord {
  return {
    id: actionId(scope, "commit-user-source"),
    status: "completed",
    description: `Committed ${commit.files.length} user canonical ${commit.files.length === 1 ? "path" : "paths"}.`,
    scope: scope.type,
    scopePath: scope.path,
    reads: commit.files,
    commit,
  };
}

async function synchronizeUserContext(
  context: ScopeContext,
  options: EngineOptions,
  plans: readonly ReconciliationPlan[],
  actions: ActionRecord[],
): Promise<void> {
  const managedPlans = plans.filter((plan) => plan.source !== "conflict" && plan.source !== "invalid");
  for (const plan of managedPlans) {
    if (plan.canonicalOperation === "write") await writeCanonicalFromPlan(context, plan);
    else if (plan.canonicalOperation === "remove") await removeCanonicalFromPlan(context, plan);
    const action = reconciliationAction(context, plan, "completed", "canonical");
    if (action !== undefined) actions.push(action);
  }

  const commitPlans = plans.filter((plan) => plan.source !== "invalid" && changesUserCanonical(plan));
  const commit = await commitManagedChanges({
    root: context.scope.canonical,
    paths: [configPath(context.scope.canonical), ...commitPlans.map((plan) => plan.canonicalPath)],
    origins: commitPlans.flatMap(changeOrigins),
    message: "overlord: synchronize",
  });
  if (commit !== null) actions.push(commitAction(context.scope, commit));

  for (const plan of plans) {
    if (plan.source === "invalid" || (plan.source === "conflict" && plan.providerOperations.length === 0)) continue;
    for (const operation of plan.providerOperations) await executeProviderOperation(context, plan, operation);
    const action = reconciliationAction(context, plan, "completed", "providers");
    if (action !== undefined) actions.push(action);
    if (plan.source !== "conflict" && requiresLedgerPersistence(plan)) {
      await persistConvergedPlan(context, plan, options);
    }
  }
}

async function synchronizeScope(
  scope: Scope,
  options: EngineOptions,
  expectedPhysicalPath: string | undefined,
  synchronizeOptions: SynchronizeOptions,
): Promise<ActionRecord[]> {
  await assertScopeIdentity(scope, expectedPhysicalPath);
  const preflight = await inventoryScope(scope, options, expectedPhysicalPath);
  if (blocksMutation(preflight)) return [];
  const release = await acquireScopeLock(scope.path);
  const actions: ActionRecord[] = [];
  let failure: unknown;
  try {
    await assertScopeIdentity(scope, expectedPhysicalPath);
    const context = await inventoryScope(scope, options, expectedPhysicalPath);
    if (!blocksMutation(context)) {
      const plans = approvedPlans(context, synchronizeOptions);
      if (scope.type === "user") await synchronizeUserContext(context, options, plans, actions);
      else {
        for (const plan of plans) {
          const action = await executeReconciliationPlan(context, plan, options);
          if (action !== undefined) actions.push(action);
        }
      }
    }
  } catch (error) {
    failure = error;
  }
  await finishLockedOperation(release, actions, failure);
  return actions;
}

export async function synchronize(
  options: EngineOptions,
  synchronizeOptions: SynchronizeOptions = {},
): Promise<OutputDocument> {
  const discovery = await fleetDiscovery(options);
  const actions: ActionRecord[] = [];
  const failures: Diagnostic[] = [];
  for (const scope of discovery.scopes) {
    if (discovery.diagnostics.some((entry) => entry.scopePath === scope.path && entry.severity === "error")) continue;
    try {
      actions.push(...await synchronizeScope(
        scope,
        options,
        discovery.physicalPaths.get(scope.path),
        synchronizeOptions,
      ));
    } catch (error) {
      actions.push(...completedActions(error));
      failures.push(scopeFailure(scope, error));
    }
  }
  const document = await fleetDocument(options, "sync", discovery);
  document.actions = [...actions, ...(document.actions ?? [])];
  document.diagnostics = [...(document.diagnostics ?? []), ...failures];
  if (failures.length > 0) document.status = "attention-required";
  return document;
}

function initAction(scope: Scope, id: string, description: string, writes: string[]): ActionRecord {
  return {
    id: actionId(scope, id),
    status: "completed",
    description,
    scope: scope.type,
    scopePath: scope.path,
    writes,
  };
}

async function bundledSkillSource(): Promise<string> {
  return readFile(new URL("../assets/overlord/SKILL.md", import.meta.url), "utf8");
}

/** Initialize only the always-present user scope and its fleet configuration. */
export async function initialize(options: EngineOptions): Promise<OutputDocument> {
  const scope: Scope = {
    type: "user",
    path: resolve(options.home),
    canonical: join(resolve(options.home), ".agents"),
  };
  const directories = [join(scope.canonical, "skills"), join(scope.canonical, "overlord", "agents")];
  const configuration = configPath(scope.canonical);
  const bundled = join(scope.canonical, "skills", "overlord", "SKILL.md");
  const actions: ActionRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  const source = await bundledSkillSource();
  let expectedPhysicalPath: string | undefined;
  try {
    expectedPhysicalPath = await realpath(scope.path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const assertInitializationParents = async (): Promise<void> => {
    for (const path of [...directories, configuration, bundled]) {
      await assertNoSymlinkedParent(path, scope.path, expectedPhysicalPath);
    }
  };

  await assertScopeIdentity(scope, expectedPhysicalPath);
  await assertInitializationParents();
  const release = await acquireScopeLock(scope.path);
  let failure: unknown;
  try {
    await assertScopeIdentity(scope, expectedPhysicalPath);
    await assertInitializationParents();
    await loadConfig(scope.canonical, scope.path);
    const repository = await ensureUserRepository(scope.canonical);
    for (const [index, directory] of directories.entries()) {
      if (await pathExists(directory)) {
        const metadata = await lstat(directory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw Object.assign(new Error(`Canonical directory must be a physical directory: ${directory}`), {
            code: "permission-denied",
            path: directory,
          });
        }
        continue;
      }
      const created = await mkdir(directory, { recursive: true });
      if (created !== undefined) {
        actions.push(initAction(
          scope,
          `initialize-directory-${index + 1}`,
          "Created a user canonical directory.",
          [directory],
        ));
      }
    }
    if (!(await pathExists(configuration))) {
      try {
        await writeFileAtomicExclusive(configuration, renderConfig({ roots: [] }));
        actions.push(initAction(scope, "initialize-config", "Created fleet discovery configuration.", [configuration]));
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    await loadConfig(scope.canonical, scope.path);
    if (!(await pathExists(bundled))) {
      try {
        await writeFileAtomicExclusive(bundled, source);
        actions.push(initAction(scope, "install-overlord-skill", "Installed the Overlord workflow skill.", [bundled]));
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    if (await pathExists(bundled) && await readFile(bundled, "utf8") !== source) {
      diagnostics.push(diagnostic(
        "warning",
        "modified-bundled-skill",
        "The installed Overlord skill differs from this release and was not overwritten.",
        bundled,
        scope.path,
      ));
    }
    const scopeIdentity = expectedPhysicalPath ?? await realpath(scope.path);
    const firstInitialization = !(await pathExists(ledgerPath(scope.canonical, scopeIdentity)));
    let commitPaths = [configuration, bundled];
    if (!repository.hasHead || firstInitialization) {
      commitPaths = [
        configuration,
        join(scope.canonical, "skills"),
        join(scope.canonical, "overlord", "agents"),
      ];
    }
    const commit = await commitManagedChanges({
      root: scope.canonical,
      paths: commitPaths,
      origins: [],
      message: "overlord: initialize",
    });
    if (commit !== null) actions.push(commitAction(scope, commit));
    const ledger = await loadScopeLedger(scope.canonical, scopeIdentity);
    await saveScopeLedger(scope.canonical, ledger);
  } catch (error) {
    failure = error;
  }
  await finishLockedOperation(release, actions, failure);

  return {
    schemaVersion: 2,
    command: "init",
    status: "ok",
    scopes: [scope],
    definitions: [],
    summary: summarize([]),
    actions,
    diagnostics,
  };
}
