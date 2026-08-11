import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { configPath, loadConfig, renderConfig } from "./config.js";
import { isPortableSkillName, loadCanonicalScope } from "./definitions.js";
import { discoverScopes, type DiscoveryResult } from "./discovery.js";
import {
  acquireScopeLock,
  assertNoSymlinkedParent,
  compareDirectories,
  copyDirectoryExclusive,
  IGNORED_SKILL_FILES,
  pathExists,
  removeWithBackup,
  replaceFileWithBackup,
  writeFileAtomicExclusive,
} from "./filesystem.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  parseClaudeAgent,
  parseCodexAgent,
  renderCanonicalAgent,
  renderClaudeAgent,
  renderCodexAgent,
} from "./render.js";
import { resolveTargetPaths, type TargetPaths } from "./targets.js";
import type {
  ActionRecord,
  ArtifactKind,
  CanonicalAgent,
  CanonicalScope,
  CanonicalSkill,
  DefinitionOutput,
  DefinitionRecord,
  DefinitionState,
  Diagnostic,
  EngineOptions,
  OutputDocument,
  Scope,
  SummaryRecord,
  TargetName,
} from "./types.js";

const FAILING_STATES = new Set<DefinitionState>(["missing", "unadopted", "conflict", "invalid"]);

interface NativeDefinition {
  kind: ArtifactKind;
  name: string;
  target: TargetName;
  path: string;
  valid: boolean;
  scanOnly?: boolean;
  agent?: CanonicalAgent;
  evidence?: string;
}

interface ScopeContext {
  scope: Scope;
  expectedPhysicalPath: string | undefined;
  paths: TargetPaths;
  canonical: CanonicalScope;
  native: NativeDefinition[];
  definitions: DefinitionRecord[];
  diagnostics: Diagnostic[];
  actions: ActionRecord[];
}

interface ProgressCarrier {
  completedActions?: ActionRecord[];
  createdBackups?: string[];
  createdPaths?: string[];
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

function createdBackups(error: unknown): string[] {
  if (error === null || typeof error !== "object") return [];
  const value = (error as ProgressCarrier).createdBackups;
  return Array.isArray(value) ? value : [];
}

function createdPaths(error: unknown): string[] {
  if (error === null || typeof error !== "object") return [];
  const value = (error as ProgressCarrier).createdPaths;
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

function key(kind: ArtifactKind, name: string): string {
  return `${kind}:${name}`;
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

function output(target: TargetName, path: string, state: DefinitionState, direct = false): DefinitionOutput {
  const result: DefinitionOutput = { target, path, state };
  if (direct) result.readsCanonicalDirectly = true;
  return result;
}

function aggregateState(states: readonly DefinitionState[]): DefinitionState {
  for (const state of ["invalid", "conflict", "unadopted", "missing", "synced"] as const) {
    if (states.includes(state)) return state;
  }
  return "synced";
}

async function directoryEntries(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw Object.assign(new Error(`Artifact root must be a physical directory: ${path}`), {
        code: "permission-denied",
        path,
      });
    }
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function nativeSkillTreeError(root: string): Promise<string | undefined> {
  let physicalRoot: string;
  try {
    physicalRoot = await realpath(root);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  async function walk(directory: string): Promise<string | undefined> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        return `native skill contains unsupported symlink '${relative(physicalRoot, path)}'`;
      }
      if (IGNORED_SKILL_FILES.has(entry.name) || entry.name.startsWith("._")) continue;
      try {
        if (entry.isDirectory()) {
          const nested = await walk(path);
          if (nested !== undefined) return nested;
        } else if (entry.isFile()) {
          await readFile(path);
        } else {
          return `skill contains unsupported filesystem entry '${relative(physicalRoot, path)}'`;
        }
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
    return undefined;
  }

  return walk(physicalRoot);
}

async function scanSkillRoot(root: string, target: TargetName, scanOnly: boolean): Promise<NativeDefinition[]> {
  const results: NativeDefinition[] = [];
  const entries = await directoryEntries(root);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryName = process.platform === "darwin" ? entry.name.normalize("NFD").toLowerCase() : entry.name;
    if (target === "codex" && entryName === ".system") continue;
    const path = join(root, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      if (isPortableSkillName(entry.name)) {
        results.push({
          kind: "skill",
          name: entry.name,
          target,
          path,
          valid: false,
          scanOnly,
          evidence: "native skill destination must be a directory",
        });
      }
      continue;
    }
    if (entry.isSymbolicLink()) {
      results.push({
        kind: "skill",
        name: entry.name,
        target,
        path,
        valid: false,
        scanOnly,
        evidence: "native skill must be a physical directory",
      });
      continue;
    }
    let valid = isPortableSkillName(entry.name);
    let evidence: string | undefined;
    try {
      const parsed = parseFrontmatter(await readFile(join(path, "SKILL.md"), "utf8"), join(path, "SKILL.md"));
      if (
        parsed.attributes.name !== entry.name
        || typeof parsed.attributes.description !== "string"
        || parsed.attributes.description.trim().length === 0
        || parsed.attributes.description.length > 1_024
      ) {
        valid = false;
        evidence = "native skill frontmatter is not portable or does not match its directory";
      }
      if (valid) {
        const treeError = await nativeSkillTreeError(path);
        if (treeError !== undefined) {
          valid = false;
          evidence = treeError;
        }
      }
    } catch (error) {
      valid = false;
      evidence = error instanceof Error ? error.message : String(error);
    }
    const result: NativeDefinition = { kind: "skill", name: entry.name, target, path, valid, scanOnly };
    if (evidence !== undefined) result.evidence = evidence;
    results.push(result);
  }
  return results;
}

async function scanAgentRoot(root: string, target: TargetName): Promise<NativeDefinition[]> {
  const paths: string[] = [];
  const unsupported: Array<{ path: string; evidence: string }> = [];
  if (target === "claude") {
    async function walk(directory: string): Promise<void> {
      const entries = await directoryEntries(directory);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        const extension = extname(entry.name);
        const agentExtension = extension.toLowerCase() === ".md";
        if (entry.isDirectory()) {
          if (agentExtension) unsupported.push({ path, evidence: "native agent destination must be a file" });
          await walk(path);
        } else if (agentExtension) {
          if (extension !== ".md") unsupported.push({ path, evidence: "Claude agent must use the lowercase '.md' extension" });
          else if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
          else unsupported.push({ path, evidence: "native agent destination must be a file" });
        }
      }
    }
    await walk(root);
  } else {
    const entries = await directoryEntries(root);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const extension = extname(entry.name);
      if (extension.toLowerCase() !== ".toml") continue;
      const path = join(root, entry.name);
      if (extension !== ".toml") unsupported.push({ path, evidence: "Codex agent must use the lowercase '.toml' extension" });
      else if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
      else unsupported.push({ path, evidence: "native agent destination must be a file" });
    }
  }

  const results: NativeDefinition[] = [];
  for (const { path, evidence } of unsupported) {
    results.push({
      kind: "agent",
      name: basename(path, extname(path)),
      target,
      path,
      valid: false,
      evidence,
    });
  }
  for (const path of paths) {
    const expectedName = basename(path, extname(path));
    if ((await lstat(path)).isSymbolicLink()) {
      results.push({
        kind: "agent",
        name: expectedName,
        target,
        path,
        valid: false,
        evidence: "native agent must be a physical file",
      });
      continue;
    }
    try {
      const source = await readFile(path, "utf8");
      const agent = target === "claude"
        ? parseClaudeAgent(source, expectedName, path)
        : parseCodexAgent(source, expectedName, path);
      const result: NativeDefinition = { kind: "agent", name: expectedName, target, path, valid: agent.valid, agent };
      if (!agent.valid) result.evidence = "native name is not portable or does not match its file";
      results.push(result);
    } catch (error) {
      results.push({
        kind: "agent",
        name: expectedName,
        target,
        path,
        valid: false,
        evidence: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function sameCommonAgent(left: CanonicalAgent, right: CanonicalAgent): boolean {
  const normalize = (value: string) => `${value.replace(/\r\n?/g, "\n").replace(/\n+$/g, "")}\n`;
  return left.name === right.name
    && left.description === right.description
    && normalize(left.body) === normalize(right.body);
}

async function scanNative(paths: TargetPaths): Promise<NativeDefinition[]> {
  const native = [
    ...await scanSkillRoot(paths.claude.skills, "claude", false),
    ...await scanAgentRoot(paths.claude.agents, "claude"),
    ...await scanSkillRoot(paths.codex.skills, "codex", true),
    ...await scanAgentRoot(paths.codex.agents, "codex"),
  ];
  native.sort((left, right) => key(left.kind, left.name).localeCompare(key(right.kind, right.name)) || left.path.localeCompare(right.path));
  return native;
}

function nativeAt(native: readonly NativeDefinition[], path: string): NativeDefinition | undefined {
  return native.find((entry) => samePath(entry.path, path));
}

async function skillOutputState(
  canonical: CanonicalSkill,
  native: NativeDefinition | undefined,
): Promise<{ state: DefinitionState; evidence?: string }> {
  if (!canonical.valid) return { state: "invalid", evidence: "canonical skill is invalid" };
  if (native === undefined) return { state: "missing" };
  if (!native.valid) {
    return native.evidence === undefined ? { state: "invalid" } : { state: "invalid", evidence: native.evidence };
  }
  const comparison = await compareDirectories(canonical.path, native.path);
  if (comparison.equal) return { state: "synced" };
  return comparison.evidence === undefined
    ? { state: "conflict" }
    : { state: "conflict", evidence: comparison.evidence };
}

async function agentOutputState(
  canonical: CanonicalAgent,
  target: TargetName,
  native: NativeDefinition | undefined,
): Promise<{ state: DefinitionState; evidence?: string }> {
  if (!canonical.valid) return { state: "invalid", evidence: "canonical agent is invalid" };
  if (native === undefined) return { state: "missing" };
  if (!native.valid) {
    return native.evidence === undefined ? { state: "invalid" } : { state: "invalid", evidence: native.evidence };
  }
  const expected = target === "claude" ? renderClaudeAgent(canonical) : renderCodexAgent(canonical);
  const actual = await readFile(native.path, "utf8");
  return actual === expected
    ? { state: "synced" }
    : { state: "conflict", evidence: "rendered content differs" };
}

function agentRenderFailure(canonical: CanonicalAgent, target: TargetName): string | undefined {
  try {
    if (target === "claude") renderClaudeAgent(canonical);
    else renderCodexAgent(canonical);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function canonicalRecords(
  scope: Scope,
  canonical: CanonicalScope,
  native: NativeDefinition[],
  paths: TargetPaths,
): Promise<{ records: DefinitionRecord[]; used: Set<string> }> {
  const records: DefinitionRecord[] = [];
  const used = new Set<string>();

  for (const skill of canonical.skills) {
    const outputs: DefinitionOutput[] = [output("codex", skill.path, skill.valid ? "synced" : "invalid", true)];
    const evidence: string[] = [];
    const claudePath = join(paths.claude.skills, skill.name);
    const claude = nativeAt(native, claudePath);
    if (claude !== undefined) used.add(claude.path);
    const claudeState = await skillOutputState(skill, claude);
    outputs.push(output("claude", claudePath, claudeState.state));
    if (claudeState.evidence !== undefined) evidence.push(`claude: ${claudeState.evidence}`);

    const scanPath = join(paths.codex.skills, skill.name);
    const duplicate = nativeAt(native, scanPath);
    if (duplicate !== undefined) {
      used.add(duplicate.path);
      let state: DefinitionState;
      if (!skill.valid) state = "invalid";
      else if (!duplicate.valid) state = "invalid";
      else state = (await compareDirectories(skill.path, duplicate.path)).equal ? "unadopted" : "conflict";
      outputs.push(output("codex", scanPath, state));
      evidence.push(state === "unadopted"
        ? "codex: redundant scan-only copy can be removed"
        : "codex: scan-only copy differs from canonical");
    }

    const state = aggregateState(outputs.map((entry) => entry.state));
    const record: DefinitionRecord = {
      kind: "skill",
      name: skill.name,
      scope: scope.type,
      scopePath: scope.path,
      state,
      canonical: skill.path,
      outputs,
    };
    if (evidence.length > 0) record.evidence = evidence.join("; ");
    records.push(record);
  }

  for (const agent of canonical.agents) {
    const outputs: DefinitionOutput[] = [];
    const evidence: string[] = [];
    const conflictsWith: string[] = [];
    for (const target of ["claude", "codex"] as const) {
      const expectedPath = join(paths[target].agents, `${agent.name}.${target === "claude" ? "md" : "toml"}`);
      const targetEntries = native.filter((entry) => entry.kind === "agent" && entry.target === target);
      const expected = targetEntries.find((entry) => samePath(entry.path, expectedPath));
      const extras = targetEntries.filter((entry) => entry.name === agent.name && !samePath(entry.path, expectedPath));
      const related = expected === undefined ? extras : [expected, ...extras];
      for (const entry of related) used.add(entry.path);

      if (agent.targets[target] === false) {
        for (const entry of related) {
          outputs.push(output(target, entry.path, entry.valid ? "conflict" : "invalid"));
          conflictsWith.push(entry.path);
        }
        if (related.length > 0) evidence.push(`${target}: native output exists although this target is disabled`);
        continue;
      }

      const renderFailure = agentRenderFailure(agent, target);
      if (renderFailure !== undefined) {
        outputs.push(output(target, expectedPath, "invalid"));
        evidence.push(`${target}: ${renderFailure}`);
        continue;
      }

      const result = await agentOutputState(agent, target, expected);
      outputs.push(output(target, expectedPath, result.state));
      if (result.evidence !== undefined) evidence.push(`${target}: ${result.evidence}`);
      for (const extra of extras) {
        outputs.push(output(target, extra.path, extra.valid ? "conflict" : "invalid"));
        conflictsWith.push(extra.path);
      }
      if (extras.length > 0) evidence.push(`${target}: duplicate native agent exists outside the standard output path`);
    }

    const states: DefinitionState[] = outputs.length > 0
      ? outputs.map((entry) => entry.state)
      : [agent.valid ? "synced" : "invalid"];
    const record: DefinitionRecord = {
      kind: "agent",
      name: agent.name,
      scope: scope.type,
      scopePath: scope.path,
      state: aggregateState(states),
      canonical: agent.path,
      outputs,
    };
    if (evidence.length > 0) record.evidence = evidence.join("; ");
    if (conflictsWith.length > 0) record.conflictsWith = conflictsWith;
    records.push(record);
  }
  return { records, used };
}

async function nativeOnlyRecords(
  scope: Scope,
  native: NativeDefinition[],
  used: Set<string>,
): Promise<DefinitionRecord[]> {
  const groups = new Map<string, NativeDefinition[]>();
  for (const entry of native) {
    if (used.has(entry.path)) continue;
    const entries = groups.get(key(entry.kind, entry.name)) ?? [];
    entries.push(entry);
    groups.set(key(entry.kind, entry.name), entries);
  }

  const records: DefinitionRecord[] = [];
  for (const entries of groups.values()) {
    const first = entries[0]!;
    const outputs = entries.map((entry) => output(entry.target, entry.path, entry.valid ? "unadopted" : "invalid"));
    let state = aggregateState(outputs.map((entry) => entry.state));
    let evidence = entries.find((entry) => entry.evidence !== undefined)?.evidence;
    const duplicateTarget = entries.length > 1 && new Set(entries.map((entry) => entry.target)).size !== entries.length;
    if (state === "unadopted" && duplicateTarget) {
      state = "conflict";
      for (const nativeOutput of outputs) nativeOutput.state = "conflict";
      evidence = "multiple native definitions use the same name in one target";
    } else if (state === "unadopted" && entries.length > 1) {
      let same = true;
      if (first.kind === "skill") {
        for (const entry of entries.slice(1)) {
          same &&= (await compareDirectories(entries[0]!.path, entry.path)).equal;
        }
      } else {
        for (const entry of entries.slice(1)) {
          same &&= entries[0]!.agent !== undefined
            && entry.agent !== undefined
            && sameCommonAgent(entries[0]!.agent, entry.agent);
        }
      }
      if (!same) {
        state = "conflict";
        for (const nativeOutput of outputs) nativeOutput.state = "conflict";
        evidence = "native target definitions differ";
      }
    }

    const record: DefinitionRecord = {
      kind: first.kind,
      name: first.name,
      scope: scope.type,
      scopePath: scope.path,
      state,
      canonical: null,
      outputs,
    };
    if (evidence !== undefined) record.evidence = evidence;
    if (state === "conflict") record.conflictsWith = entries.map((entry) => entry.path);
    records.push(record);
  }
  return records;
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

function expectedAgentPath(context: ScopeContext, name: string, target: TargetName): string {
  return join(context.paths[target].agents, `${name}.${target === "claude" ? "md" : "toml"}`);
}

function plannedActions(context: ScopeContext, definition: DefinitionRecord): ActionRecord[] {
  const actions: ActionRecord[] = [];
  const missingOutputs = definition.outputs.filter((entry) => entry.state === "missing");
  if (definition.canonical !== null && definition.state !== "invalid" && missingOutputs.length > 0) {
    const writes = missingOutputs.map((entry) => entry.path);
    actions.push({
      id: actionId(context.scope, `materialize-${definition.kind}-${definition.name}`),
      status: "planned",
      description: `Materialize missing ${definition.kind} '${definition.name}'.`,
      scope: definition.scope,
      scopePath: definition.scopePath,
      reads: definition.canonical === null ? [] : [definition.canonical],
      writes,
    });
  }
  if (definition.state !== "unadopted") return actions;

  if (definition.canonical !== null) {
    const removes = definition.outputs.filter((entry) => entry.state === "unadopted").map((entry) => entry.path);
    actions.push({
      id: actionId(context.scope, `remove-redundant-${definition.kind}-${definition.name}`),
      status: "planned",
      description: `Remove redundant native ${definition.kind} '${definition.name}' after backup.`,
      scope: definition.scope,
      scopePath: definition.scopePath,
      reads: [definition.canonical, ...removes],
      removes,
    });
    return actions;
  }

  const canonicalDestination = definition.kind === "skill"
    ? join(context.scope.canonical, "skills", definition.name)
    : join(context.scope.canonical, "overlord", "agents", `${definition.name}.md`);
  const writes = new Set<string>([canonicalDestination]);
  if (definition.kind === "skill") writes.add(join(context.paths.claude.skills, definition.name));
  else {
    writes.add(expectedAgentPath(context, definition.name, "claude"));
    writes.add(expectedAgentPath(context, definition.name, "codex"));
  }
  const removes = definition.outputs
    .filter((entry) => definition.kind === "skill"
      ? entry.target === "codex"
      : !samePath(entry.path, expectedAgentPath(context, definition.name, entry.target)))
    .map((entry) => entry.path);
  actions.push({
    id: actionId(context.scope, `adopt-${definition.kind}-${definition.name}`),
    status: "planned",
    description: `Adopt and replicate native ${definition.kind} '${definition.name}'.`,
    scope: definition.scope,
    scopePath: definition.scopePath,
    reads: definition.outputs.map((entry) => entry.path),
    writes: [...writes],
    removes,
  });
  return actions;
}

async function inventoryScope(
  scope: Scope,
  options: EngineOptions,
  expectedPhysicalPath: string | undefined,
): Promise<ScopeContext> {
  const paths = resolveTargetPaths(scope, options);
  for (const target of ["claude", "codex"] as const) {
    const boundary = nativeBoundaryFor(scope, paths, target);
    const expectedBoundary = expectedBoundaryIdentity(scope, boundary, expectedPhysicalPath);
    await assertNoSymlinkedParent(join(paths[target].skills, ".overlord-inventory"), boundary, expectedBoundary);
    await assertNoSymlinkedParent(join(paths[target].agents, ".overlord-inventory"), boundary, expectedBoundary);
  }
  const canonical = await loadCanonicalScope(scope.canonical);
  const diagnostics = canonical.diagnostics.map((entry): Diagnostic => ({ ...entry, scopePath: scope.path }));
  const native = await scanNative(paths);
  const { records, used } = await canonicalRecords(scope, canonical, native, paths);
  records.push(...await nativeOnlyRecords(scope, native, used));
  records.sort((left, right) => key(left.kind, left.name).localeCompare(key(right.kind, right.name)));
  const context: ScopeContext = {
    scope,
    expectedPhysicalPath,
    paths,
    canonical,
    native,
    definitions: records,
    diagnostics,
    actions: [],
  };
  if (!blocksMutation(context)) context.actions = records.flatMap((record) => plannedActions(context, record));
  return context;
}

async function fleetDiscovery(options: EngineOptions): Promise<DiscoveryResult> {
  const canonicalRoot = join(options.home, ".agents");
  const config = await loadConfig(canonicalRoot, options.home);
  const discovery = await discoverScopes({ home: options.home, roots: config.roots });
  const comparablePaths = new Map<string, Promise<string>>();
  const userScope = discovery.scopes[0]!;
  const userPaths = resolveTargetPaths(userScope, options);
  const userArtifactRoots = [
    { name: "Claude", path: userPaths.claude.skills },
    { name: "Claude", path: userPaths.claude.agents },
    { name: "Codex", path: userPaths.codex.skills },
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
    const artifactRoots = [
      { label: "canonical skills", path: join(scope.canonical, "skills") },
      { label: "canonical agents", path: join(scope.canonical, "overlord", "agents") },
      { label: "Claude skills", path: paths.claude.skills },
      { label: "Claude agents", path: paths.claude.agents },
      { label: "Codex scan-only skills", path: paths.codex.skills },
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
        paths.codex.skills,
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

function canonicalByKey(context: ScopeContext): Map<string, CanonicalSkill | CanonicalAgent> {
  const definitions = new Map<string, CanonicalSkill | CanonicalAgent>();
  for (const skill of context.canonical.skills) definitions.set(key("skill", skill.name), skill);
  for (const agent of context.canonical.agents) definitions.set(key("agent", agent.name), agent);
  return definitions;
}

function nativeBoundaryFor(scope: Scope, paths: TargetPaths, target: TargetName): string {
  if (scope.type === "project") return scope.path;
  const nativeRoot = dirname(paths[target].skills);
  return dirname(nativeRoot);
}

function nativeBoundary(context: ScopeContext, target: TargetName): string {
  return nativeBoundaryFor(context.scope, context.paths, target);
}

async function materialize(
  context: ScopeContext,
  definition: DefinitionRecord,
  canonical: CanonicalSkill | CanonicalAgent,
  nativeOutput: DefinitionOutput,
  overwrite: boolean,
): Promise<ActionRecord> {
  const backups: string[] = [];
  await assertContextParent(context, nativeOutput.path, nativeBoundary(context, nativeOutput.target));
  if (definition.kind === "skill") {
    if (nativeOutput.readsCanonicalDirectly === true) throw new Error("Codex canonical skills are never materialized.");
    if (overwrite) throw new Error("Skill conflicts are never overwritten.");
    try {
      await copyDirectoryExclusive(canonical.path, nativeOutput.path);
    } catch (error) {
      const partialPaths = createdPaths(error);
      if (partialPaths.length > 0) {
        throw withCompletedActions(error, [{
          id: actionId(context.scope, `partial-materialize-skill-${definition.name}-${nativeOutput.target}`),
          status: "completed",
          description: `Created a partial ${nativeOutput.target} skill '${definition.name}' before publication failed.`,
          scope: definition.scope,
          scopePath: definition.scopePath,
          reads: [canonical.path],
          writes: partialPaths,
        }]);
      }
      throw error;
    }
  } else {
    const agent = canonical as CanonicalAgent;
    const rendered = nativeOutput.target === "claude" ? renderClaudeAgent(agent) : renderCodexAgent(agent);
    try {
      if (overwrite) {
        backups.push(await replaceFileWithBackup(
          nativeOutput.path,
          rendered,
          context.paths[nativeOutput.target].agents,
        ));
      }
      else await writeFileAtomicExclusive(nativeOutput.path, rendered);
    } catch (error) {
      const failedBackups = [...backups, ...createdBackups(error)];
      if (failedBackups.length > 0) {
        throw withCompletedActions(error, [{
          id: actionId(context.scope, `backup-before-failed-agent-${definition.name}-${nativeOutput.target}`),
          status: "completed",
          description: `Created a backup before replacing ${nativeOutput.target} agent '${definition.name}'.`,
          scope: definition.scope,
          scopePath: definition.scopePath,
          reads: [nativeOutput.path],
          writes: failedBackups,
          backups: failedBackups,
        }]);
      }
      throw error;
    }
  }
  const action: ActionRecord = {
    id: actionId(context.scope, `${overwrite ? "replace" : "materialize"}-${definition.kind}-${definition.name}-${nativeOutput.target}`),
    status: "completed",
    description: `${overwrite ? "Replaced" : "Materialized"} ${nativeOutput.target} ${definition.kind} '${definition.name}'.`,
    scope: definition.scope,
    scopePath: definition.scopePath,
    reads: [canonical.path],
    writes: [nativeOutput.path],
  };
  if (backups.length > 0) action.backups = backups;
  return action;
}

function blocksMutation(context: ScopeContext): boolean {
  return context.diagnostics.some((entry) => entry.severity === "error")
    || context.definitions.some((entry) => entry.canonical !== null && entry.state === "invalid");
}

async function materializeMissing(context: ScopeContext): Promise<ActionRecord[]> {
  const canonical = canonicalByKey(context);
  const actions: ActionRecord[] = [];
  try {
    for (const record of context.definitions) {
      if (record.canonical === null || record.state === "invalid") continue;
      const definition = canonical.get(key(record.kind, record.name));
      if (definition === undefined || !definition.valid) continue;
      for (const nativeOutput of record.outputs) {
        if (nativeOutput.state === "missing") {
          actions.push(await materialize(context, record, definition, nativeOutput, false));
        }
      }
    }
  } catch (error) {
    throw withCompletedActions(error, actions);
  }
  return actions;
}

function nativeForRecord(context: ScopeContext, definition: DefinitionRecord): NativeDefinition[] {
  const paths = new Set(definition.outputs.map((entry) => filesystemComparisonPath(entry.path)));
  return context.native.filter((entry) => paths.has(filesystemComparisonPath(entry.path)));
}

function mergedNativeAgent(entries: NativeDefinition[]): CanonicalAgent {
  const source = entries[0];
  if (source?.agent === undefined) throw new Error("Native agent is invalid and cannot be adopted.");
  const targets: CanonicalAgent["targets"] = { claude: {}, codex: {} };
  for (const entry of entries) {
    if (entry.agent !== undefined) targets[entry.target] = entry.agent.targets[entry.target];
  }
  return { ...source.agent, targets, valid: true };
}

async function installCanonicalAgent(context: ScopeContext, agent: CanonicalAgent): Promise<ActionRecord> {
  const path = join(context.scope.canonical, "overlord", "agents", `${agent.name}.md`);
  await assertContextParent(context, path, context.scope.path);
  await writeFileAtomicExclusive(path, renderCanonicalAgent({ ...agent, path }));
  return {
    id: actionId(context.scope, `adopt-agent-${agent.name}`),
    status: "completed",
    description: `Adopted canonical agent '${agent.name}'.`,
    scope: context.scope.type,
    scopePath: context.scope.path,
    reads: [agent.path],
    writes: [path],
  };
}

async function installCanonicalSkill(context: ScopeContext, source: NativeDefinition): Promise<ActionRecord> {
  const destination = join(context.scope.canonical, "skills", source.name);
  await assertContextParent(context, destination, context.scope.path);
  if (source.scanOnly === true) await assertContextParent(context, source.path, nativeBoundary(context, source.target));
  const verifiedSource = await realpath(source.path);
  const backups: string[] = [];
  let installed = false;
  try {
    await copyDirectoryExclusive(verifiedSource, destination);
    installed = true;
    if (source.scanOnly === true) {
      const comparison = await compareDirectories(destination, verifiedSource);
      if (!comparison.equal) throw new Error(`Adoption verification failed: ${comparison.evidence ?? "directory differs"}`);
      backups.push(await removeWithBackup(source.path, context.paths[source.target].skills));
    }
  } catch (error) {
    const completed: ActionRecord[] = [];
    if (installed || createdPaths(error).includes(destination)) {
      completed.push({
        id: actionId(context.scope, `partial-adopt-skill-${source.name}`),
        status: "completed",
        description: `Installed canonical skill '${source.name}' before cleanup failed.`,
        scope: context.scope.type,
        scopePath: context.scope.path,
        reads: [source.path],
        writes: [destination],
      });
    }
    const failedBackups = createdBackups(error);
    if (failedBackups.length > 0) {
      completed.push({
        id: actionId(context.scope, `backup-before-failed-remove-skill-${source.name}`),
        status: "completed",
        description: `Created a backup before cleanup of scan-only skill '${source.name}' failed.`,
        scope: context.scope.type,
        scopePath: context.scope.path,
        reads: [source.path],
        writes: failedBackups,
        backups: failedBackups,
      });
    }
    throw withCompletedActions(error, completed);
  }
  const action: ActionRecord = {
    id: actionId(context.scope, `adopt-skill-${source.name}`),
    status: "completed",
    description: `Adopted canonical skill '${source.name}'.`,
    scope: context.scope.type,
    scopePath: context.scope.path,
    reads: [source.path],
    writes: [destination],
  };
  if (source.scanOnly === true) action.removes = [source.path];
  if (backups.length > 0) action.backups = backups;
  return action;
}

async function removeWithRecordedBackup(
  context: ScopeContext,
  definition: DefinitionRecord,
  entry: NativeDefinition,
  description: string,
): Promise<ActionRecord> {
  await assertContextParent(context, entry.path, nativeBoundary(context, entry.target));
  let backup: string;
  try {
    const artifactRoot = entry.kind === "skill"
      ? context.paths[entry.target].skills
      : context.paths[entry.target].agents;
    backup = await removeWithBackup(entry.path, artifactRoot);
  } catch (error) {
    const failedBackups = createdBackups(error);
    if (failedBackups.length > 0) {
      throw withCompletedActions(error, [{
        id: actionId(context.scope, `backup-before-failed-remove-${definition.kind}-${definition.name}-${entry.target}`),
        status: "completed",
        description: `Created a backup before removing ${entry.target} ${definition.kind} '${definition.name}' failed.`,
        scope: context.scope.type,
        scopePath: context.scope.path,
        reads: [entry.path],
        writes: failedBackups,
        backups: failedBackups,
      }]);
    }
    throw error;
  }
  return {
    id: actionId(context.scope, `remove-${definition.kind}-${definition.name}-${entry.target}`),
    status: "completed",
    description,
    scope: context.scope.type,
    scopePath: context.scope.path,
    reads: [entry.path],
    removes: [entry.path],
    backups: [backup],
  };
}

async function convergeAdopted(
  originalContext: ScopeContext,
  options: EngineOptions,
  kind: ArtifactKind,
  name: string,
): Promise<ActionRecord[]> {
  const context = await inventoryScope(
    originalContext.scope,
    options,
    originalContext.expectedPhysicalPath,
  );
  const record = context.definitions.find((entry) => entry.kind === kind && entry.name === name && entry.canonical !== null);
  const canonical = canonicalByKey(context).get(key(kind, name));
  if (record === undefined || canonical === undefined || !canonical.valid) return [];
  const actions: ActionRecord[] = [];
  try {
    for (const nativeOutput of record.outputs) {
      if (nativeOutput.readsCanonicalDirectly === true) continue;
      const entry = nativeAt(context.native, nativeOutput.path);
      if (kind === "skill" && nativeOutput.target === "codex" && entry?.scanOnly === true) {
        actions.push(await removeWithRecordedBackup(
          context,
          record,
          entry,
          `Removed redundant Codex skill '${name}' after adoption.`,
        ));
        continue;
      }
      if (kind === "agent" && !samePath(nativeOutput.path, expectedAgentPath(context, name, nativeOutput.target))) {
        if (entry !== undefined) {
          actions.push(await removeWithRecordedBackup(
            context,
            record,
            entry,
            `Removed duplicate ${nativeOutput.target} agent '${name}' after adoption.`,
          ));
        }
        continue;
      }
      if (nativeOutput.state === "missing") actions.push(await materialize(context, record, canonical, nativeOutput, false));
      else if (kind === "agent" && nativeOutput.state === "conflict") {
        actions.push(await materialize(context, record, canonical, nativeOutput, true));
      }
    }
  } catch (error) {
    throw withCompletedActions(error, actions);
  }
  return actions;
}

async function adoptNativeOnly(
  context: ScopeContext,
  definition: DefinitionRecord,
  options: EngineOptions,
): Promise<ActionRecord[]> {
  const entries = nativeForRecord(context, definition);
  if (entries.length === 0 || entries.some((entry) => !entry.valid)) return [];
  const actions: ActionRecord[] = [];
  try {
    if (definition.kind === "skill") {
      const source = entries.find((entry) => entry.target === "claude") ?? entries[0]!;
      actions.push(await installCanonicalSkill(context, source));
    } else {
      actions.push(await installCanonicalAgent(context, mergedNativeAgent(entries)));
    }
    actions.push(...await convergeAdopted(context, options, definition.kind, definition.name));
  } catch (error) {
    throw withCompletedActions(error, actions);
  }
  return actions;
}

async function removeRedundantCanonicalOutputs(
  context: ScopeContext,
  definition: DefinitionRecord,
): Promise<ActionRecord[]> {
  const entries = nativeForRecord(context, definition);
  const actions: ActionRecord[] = [];
  try {
    for (const entry of entries) {
      if (entry.kind !== "skill" || entry.scanOnly !== true) continue;
      actions.push(await removeWithRecordedBackup(
        context,
        definition,
        entry,
        `Removed redundant Codex skill '${definition.name}'.`,
      ));
    }
  } catch (error) {
    throw withCompletedActions(error, actions);
  }
  return actions;
}

async function synchronizeScope(scope: Scope, options: EngineOptions, expectedPhysicalPath: string | undefined): Promise<ActionRecord[]> {
  await assertScopeIdentity(scope, expectedPhysicalPath);
  const preflight = await inventoryScope(scope, options, expectedPhysicalPath);
  if (blocksMutation(preflight)) return [];
  const release = await acquireScopeLock(scope.path);
  const actions: ActionRecord[] = [];
  let failure: unknown;
  try {
    await assertScopeIdentity(scope, expectedPhysicalPath);
    let context = await inventoryScope(scope, options, expectedPhysicalPath);
    if (!blocksMutation(context)) {
      actions.push(...await materializeMissing(context));
      context = await inventoryScope(scope, options, expectedPhysicalPath);
      const pending = context.definitions.filter((entry) => entry.state === "unadopted");
      for (const definition of pending) {
        context = await inventoryScope(scope, options, expectedPhysicalPath);
        const current = context.definitions.find((entry) => entry.kind === definition.kind && entry.name === definition.name);
        if (current?.state !== "unadopted") continue;
        if (current.canonical === null) actions.push(...await adoptNativeOnly(context, current, options));
        else actions.push(...await removeRedundantCanonicalOutputs(context, current));
      }
      context = await inventoryScope(scope, options, expectedPhysicalPath);
      actions.push(...await materializeMissing(context));
    }
  } catch (error) {
    failure = error;
  }
  await finishLockedOperation(release, actions, failure);
  return actions;
}

export async function synchronize(options: EngineOptions): Promise<OutputDocument> {
  const discovery = await fleetDiscovery(options);
  const actions: ActionRecord[] = [];
  const failures: Diagnostic[] = [];
  for (const scope of discovery.scopes) {
    if (discovery.diagnostics.some((entry) => entry.scopePath === scope.path && entry.severity === "error")) continue;
    try {
      actions.push(...await synchronizeScope(scope, options, discovery.physicalPaths.get(scope.path)));
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
        await writeFileAtomicExclusive(configuration, renderConfig({ version: 2, roots: [] }));
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
