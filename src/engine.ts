import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { addExternal, configPath, isExternal, loadConfig, renderConfig, type ExternalEntry, type OverlordConfig } from "./config.js";
import { isPortableSkillName, loadCanonicalScope } from "./definitions.js";
import {
  acquireScopeLock,
  assertNoSymlinkedParent,
  compareDirectories,
  copyDirectoryAtomic,
  createBackup,
  isDanglingSymlink,
  pathExists,
  removeWithBackup,
  replaceDirectoryWithBackup,
  symlinkResolvesTo,
  writeFileAtomic,
} from "./filesystem.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  parseClaudeAgent,
  parseCodexAgent,
  renderCanonicalAgent,
  renderClaudeAgent,
  renderCodexAgent,
} from "./render.js";
import { resolveScope } from "./scope.js";
import { resolveAvailability, resolveTargetPaths, targetRecords, type TargetPaths } from "./targets.js";
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
  InitializeOptions,
  OutputDocument,
  ResolutionSide,
  Scope,
  SummaryRecord,
  SyncOptions,
  TargetName,
} from "./types.js";

const VERSION = "0.1.0";
const FAILING_STATES = new Set<DefinitionState>(["missing", "unadopted", "conflict", "invalid"]);

interface NativeDefinition {
  kind: ArtifactKind;
  name: string;
  target: TargetName;
  path: string;
  valid: boolean;
  scanOnly?: boolean;
  dangling?: boolean;
  agent?: CanonicalAgent;
  evidence?: string;
}

interface InventoryContext {
  scope: Scope;
  paths: TargetPaths;
  config: OverlordConfig;
  canonical: CanonicalScope;
  native: NativeDefinition[];
  definitions: DefinitionRecord[];
  diagnostics: Diagnostic[];
  document: OutputDocument;
}

interface ProgressCarrier {
  completedActions?: ActionRecord[];
  createdBackups?: string[];
}

function withCompletedActions(error: unknown, actions: ActionRecord[]): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  const carrier = failure as Error & ProgressCarrier;
  const nested = Array.isArray(carrier.completedActions) ? carrier.completedActions : [];
  carrier.completedActions = [...actions, ...nested];
  return failure;
}

function createdBackups(error: unknown): string[] {
  if (error === null || typeof error !== "object") return [];
  const value = (error as ProgressCarrier).createdBackups;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function diagnostic(severity: Diagnostic["severity"], code: string, message: string, path?: string): Diagnostic {
  const result: Diagnostic = { severity, code, message };
  if (path !== undefined) result.path = path;
  return result;
}

function key(kind: ArtifactKind, name: string): string {
  return `${kind}:${name}`;
}

function selector(scope: Scope, kind: ArtifactKind, name: string): string {
  return `${kind}:${name}@${scope.type === "user" ? "user" : scope.path}`;
}

function projectField(scope: Scope): Pick<DefinitionRecord, "project"> {
  return scope.type === "project" ? { project: scope.path } : {};
}

function output(target: TargetName, path: string, state: DefinitionState, direct = false): DefinitionOutput {
  const result: DefinitionOutput = { target, path, state };
  if (direct) result.readsCanonicalDirectly = true;
  return result;
}

function aggregateState(states: DefinitionState[]): DefinitionState {
  for (const state of ["invalid", "conflict", "unadopted", "missing", "external", "synced"] as const) {
    if (states.includes(state)) return state;
  }
  return "synced";
}

function decisionOptions(kind: ArtifactKind, outputs: DefinitionOutput[], canonical: boolean): ResolutionSide[] {
  if (!canonical) {
    const targets = [...new Set(outputs.map((entry) => entry.target))];
    return targets.length > 1 ? [...targets, "skip"] : ["adopt", "external", "delete", "skip"];
  }
  const options: ResolutionSide[] = ["agents"];
  const targetCanBeChosen = (target: TargetName): boolean => {
    if (outputs.filter((entry) => entry.state === "conflict" && entry.target === target).length !== 1) return false;
    if (kind === "skill") return true;
    return outputs.filter((entry) =>
      entry.target === target
      && entry.state !== "missing"
      && entry.state !== "external",
    ).length === 1;
  };
  if (targetCanBeChosen("claude")) options.push("claude");
  if (targetCanBeChosen("codex")) options.push("codex");
  if (kind === "skill" && !outputs.some((entry) => entry.target === "codex" && entry.state === "conflict")) {
    const codexIndex = options.indexOf("codex");
    if (codexIndex >= 0) options.splice(codexIndex, 1);
  }
  options.push("skip");
  return options;
}

async function directoryEntries(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function scanSkillRoot(
  root: string,
  target: TargetName,
  scanOnly: boolean,
): Promise<NativeDefinition[]> {
  const results: NativeDefinition[] = [];
  const entries = await directoryEntries(root);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === ".system") continue;
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
    if (await isDanglingSymlink(path)) {
      results.push({ kind: "skill", name: entry.name, target, path, valid: false, scanOnly, dangling: true, evidence: "symlink target is missing" });
      continue;
    }
    let valid = isPortableSkillName(entry.name);
    let evidence: string | undefined;
    try {
      const parsed = parseFrontmatter(await readFile(join(path, "SKILL.md"), "utf8"), join(path, "SKILL.md"));
      if (parsed.attributes.name !== entry.name || typeof parsed.attributes.description !== "string" || parsed.attributes.description.trim().length === 0) {
        valid = false;
        evidence = "native skill frontmatter does not match its directory";
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

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await directoryEntries(directory);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if ((entry.isFile() || entry.isSymbolicLink()) && extname(entry.name) === ".md") files.push(path);
    }
  }
  await walk(root);
  return files;
}

async function scanAgentRoot(root: string, target: TargetName): Promise<NativeDefinition[]> {
  const paths: string[] = [];
  const unsupported: string[] = [];
  if (target === "claude") {
    async function walk(directory: string): Promise<void> {
      const entries = await directoryEntries(directory);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (extname(entry.name) === ".md") unsupported.push(path);
          await walk(path);
        } else if (extname(entry.name) === ".md") {
          if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
          else unsupported.push(path);
        }
      }
    }
    await walk(root);
  } else {
    const entries = await directoryEntries(root);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (extname(entry.name) !== ".toml") continue;
      const path = join(root, entry.name);
      if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
      else unsupported.push(path);
    }
  }
  const results: NativeDefinition[] = [];
  for (const path of unsupported) {
    results.push({
      kind: "agent",
      name: basename(path, extname(path)),
      target,
      path,
      valid: false,
      evidence: "native agent destination must be a file, but a directory or unsupported entry exists there",
    });
  }
  for (const path of paths) {
    const expectedName = basename(path, extname(path));
    if (await isDanglingSymlink(path)) {
      results.push({ kind: "agent", name: expectedName, target, path, valid: false, dangling: true, evidence: "symlink target is missing" });
      continue;
    }
    try {
      const source = await readFile(path, "utf8");
      const agent = target === "claude"
        ? parseClaudeAgent(source, expectedName, path)
        : parseCodexAgent(source, expectedName, path);
      const result: NativeDefinition = { kind: "agent", name: agent.name, target, path, valid: agent.valid, agent };
      if (!agent.valid) result.evidence = "native name is not portable or does not match its file";
      results.push(result);
    } catch (error) {
      results.push({ kind: "agent", name: expectedName, target, path, valid: false, evidence: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

function sameCommonAgent(left: CanonicalAgent, right: CanonicalAgent): boolean {
  const normalize = (value: string) => `${value.replace(/\r\n?/g, "\n").replace(/\n+$/g, "")}\n`;
  return left.name === right.name && left.description === right.description && normalize(left.body) === normalize(right.body);
}

async function scanNative(
  paths: TargetPaths,
  availability: ReturnType<typeof resolveAvailability>,
  diagnostics: Diagnostic[],
): Promise<NativeDefinition[]> {
  const native: NativeDefinition[] = [];
  if (availability.claude.available) {
    native.push(...await scanSkillRoot(paths.claude.skills, "claude", false));
    native.push(...await scanAgentRoot(paths.claude.agents, "claude"));
    const commands = (await collectMarkdownFiles(paths.claude.commands));
    for (const command of commands) diagnostics.push(diagnostic(
      "warning",
      "unmanaged-claude-command",
      "Legacy Claude command is visible to Claude but is not managed by Overlord 0.1.",
      command,
    ));
  }
  if (availability.codex.available) {
    native.push(...await scanSkillRoot(paths.codex.skills, "codex", true));
    native.push(...await scanAgentRoot(paths.codex.agents, "codex"));
  }
  native.sort((left, right) => key(left.kind, left.name).localeCompare(key(right.kind, right.name)) || left.path.localeCompare(right.path));
  return native;
}

function nativeAt(native: NativeDefinition[], path: string): NativeDefinition | undefined {
  return native.find((entry) => resolve(entry.path) === resolve(path));
}

async function skillOutputState(canonical: CanonicalSkill, native: NativeDefinition | undefined): Promise<{ state: DefinitionState; evidence?: string }> {
  if (!canonical.valid) return { state: "invalid", evidence: "canonical skill is invalid" };
  if (native === undefined) return { state: "missing" };
  if (!native.valid || native.dangling === true) {
    return native.evidence === undefined ? { state: "invalid" } : { state: "invalid", evidence: native.evidence };
  }
  if (await symlinkResolvesTo(native.path, canonical.path)) return { state: "synced" };
  const comparison = await compareDirectories(canonical.path, native.path);
  if (comparison.equal) return { state: "synced" };
  return comparison.evidence === undefined ? { state: "conflict" } : { state: "conflict", evidence: comparison.evidence };
}

async function agentOutputState(canonical: CanonicalAgent, target: TargetName, native: NativeDefinition | undefined): Promise<{ state: DefinitionState; evidence?: string }> {
  if (!canonical.valid) return { state: "invalid", evidence: "canonical agent is invalid" };
  if (native === undefined) return { state: "missing" };
  if (!native.valid || native.dangling === true) {
    return native.evidence === undefined ? { state: "invalid" } : { state: "invalid", evidence: native.evidence };
  }
  const expected = target === "claude" ? renderClaudeAgent(canonical) : renderCodexAgent(canonical);
  const actual = await readFile(native.path, "utf8");
  return actual === expected ? { state: "synced" } : { state: "conflict", evidence: "rendered content differs" };
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

function withDecision(record: DefinitionRecord, scope: Scope, options: ResolutionSide[]): DefinitionRecord {
  return { ...record, decision: { selector: selector(scope, record.kind, record.name), options } };
}

async function canonicalRecords(
  scope: Scope,
  canonical: CanonicalScope,
  native: NativeDefinition[],
  config: OverlordConfig,
  availability: ReturnType<typeof resolveAvailability>,
  paths: TargetPaths,
): Promise<{ records: DefinitionRecord[]; used: Set<string> }> {
  const records: DefinitionRecord[] = [];
  const used = new Set<string>();

  for (const skill of canonical.skills) {
    const outputs: DefinitionOutput[] = [];
    const evidence: string[] = [];
    if (availability.codex.available) outputs.push(output("codex", skill.path, skill.valid ? "synced" : "invalid", true));
    if (availability.claude.available) {
      const path = join(paths.claude.skills, skill.name);
      const found = nativeAt(native, path);
      if (found !== undefined) used.add(found.path);
      const external = isExternal(config, "skill", skill.name, "claude");
      const result = external !== undefined && found !== undefined ? { state: "external" as const } : await skillOutputState(skill, found);
      outputs.push(output("claude", path, result.state));
      if (result.evidence !== undefined) evidence.push(result.evidence);
    }
    if (availability.codex.available) {
      const scanPath = join(paths.codex.skills, skill.name);
      const duplicate = nativeAt(native, scanPath);
      if (duplicate !== undefined) {
        used.add(duplicate.path);
        const external = isExternal(config, "skill", skill.name, "codex");
        outputs.push(output("codex", scanPath, external === undefined ? (duplicate.valid ? "conflict" : "invalid") : "external"));
        evidence.push("same-named skill also exists in a Codex scan-only location");
      }
    }
    const state = aggregateState(outputs.map((entry) => entry.state));
    let record: DefinitionRecord = {
      kind: "skill",
      name: skill.name,
      scope: scope.type,
      ...projectField(scope),
      state,
      canonical: skill.path,
      outputs,
    };
    if (evidence.length > 0) record.evidence = evidence.join("; ");
    if (state === "conflict") record = withDecision(record, scope, decisionOptions("skill", outputs, true));
    records.push(record);
  }

  for (const agent of canonical.agents) {
    const outputs: DefinitionOutput[] = [];
    const evidence: string[] = [];
    const conflictsWith: string[] = [];
    for (const target of ["claude", "codex"] as const) {
      if (!availability[target].available) continue;
      const path = join(paths[target].agents, `${agent.name}.${target === "claude" ? "md" : "toml"}`);
      const found = nativeAt(native, path);
      const sameName = native.filter((entry) =>
        entry.kind === "agent"
        && entry.name === agent.name
        && entry.target === target,
      );
      const extras = sameName.filter((entry) => resolve(entry.path) !== resolve(path));
      for (const entry of sameName) used.add(entry.path);
      if (agent.targets[target] === false) {
        const external = isExternal(config, "agent", agent.name, target);
        const duplicate = external === undefined && sameName.length > 1;
        for (const entry of sameName) {
          outputs.push(output(
            target,
            entry.path,
            external !== undefined ? "external" : entry.valid ? (duplicate ? "conflict" : "unadopted") : "invalid",
          ));
        }
        if (sameName.length > 0) evidence.push(`${target}: native output exists although the canonical target is disabled`);
        if (duplicate) {
          conflictsWith.push(...sameName.map((entry) => entry.path));
          evidence.push(`${target}: multiple same-named native agents cannot be adopted deterministically`);
        }
        continue;
      }
      const renderFailure = agentRenderFailure(agent, target);
      if (renderFailure !== undefined) {
        outputs.push(output(target, path, "invalid"));
        evidence.push(`${target}: ${renderFailure}`);
        continue;
      }
      const external = isExternal(config, "agent", agent.name, target);
      const result = external !== undefined && found !== undefined ? { state: "external" as const } : await agentOutputState(agent, target, found);
      outputs.push(output(target, path, result.state));
      if (result.evidence !== undefined) evidence.push(`${target}: ${result.evidence}`);
      for (const entry of extras) {
        const extraExternal = isExternal(config, "agent", agent.name, target);
        const extraState = extraExternal !== undefined ? "external" : entry.valid ? "conflict" : "invalid";
        outputs.push(output(target, entry.path, extraState));
        if (extraState !== "external") conflictsWith.push(entry.path);
      }
      if (extras.length > 0) evidence.push(`${target}: same-named native agent also exists outside the canonical output path`);
    }
    const state = aggregateState(outputs.length > 0 ? outputs.map((entry) => entry.state) : [agent.valid ? "synced" : "invalid"]);
    let record: DefinitionRecord = {
      kind: "agent",
      name: agent.name,
      scope: scope.type,
      ...projectField(scope),
      state,
      canonical: agent.path,
      outputs,
    };
    if (evidence.length > 0) record.evidence = evidence.join("; ");
    if (conflictsWith.length > 0) record.conflictsWith = conflictsWith;
    if (state === "conflict") record = withDecision(record, scope, decisionOptions("agent", outputs, true));
    if (state === "unadopted") record = withDecision(record, scope, ["adopt", "external", "delete", "skip"]);
    records.push(record);
  }
  return { records, used };
}

async function nativeOnlyRecords(
  scope: Scope,
  native: NativeDefinition[],
  used: Set<string>,
  config: OverlordConfig,
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
    const externalEntries = entries.map((entry) => isExternal(config, entry.kind, entry.name, entry.target));
    const outputs = entries.map((entry, index) => output(
      entry.target,
      entry.path,
      externalEntries[index] !== undefined ? "external" : entry.valid ? "unadopted" : "invalid",
    ));
    const activeEntries = entries.filter((_entry, index) => externalEntries[index] === undefined);
    let state = aggregateState(outputs.map((entry) => entry.state));
    let evidence = entries.find((entry) => entry.evidence !== undefined)?.evidence;
    const duplicateTarget = activeEntries.length > 1 && new Set(activeEntries.map((entry) => entry.target)).size !== activeEntries.length;
    if (state === "unadopted" && duplicateTarget) {
      state = "conflict";
      for (const nativeOutput of outputs) if (nativeOutput.state !== "external") nativeOutput.state = "conflict";
      evidence = "multiple native definitions declare the same name in one target; provider selection order is not deterministic";
    } else if (state === "unadopted" && activeEntries.length > 1) {
      let same = true;
      if (first.kind === "skill") {
        for (const entry of activeEntries.slice(1)) same &&= (await compareDirectories(activeEntries[0]!.path, entry.path)).equal;
      } else {
        for (const entry of activeEntries.slice(1)) {
          same &&= activeEntries[0]!.agent !== undefined && entry.agent !== undefined && sameCommonAgent(activeEntries[0]!.agent, entry.agent);
        }
      }
      if (!same) {
        state = "conflict";
        for (const nativeOutput of outputs) if (nativeOutput.state !== "external") nativeOutput.state = "conflict";
        evidence = "native target definitions differ";
      }
    }
    let record: DefinitionRecord = {
      kind: first.kind,
      name: first.name,
      scope: scope.type,
      ...projectField(scope),
      state,
      canonical: null,
      outputs,
    };
    if (evidence !== undefined) record.evidence = evidence;
    if (duplicateTarget) record.conflictsWith = activeEntries.map((entry) => entry.path);
    const externalReason = externalEntries.find((entry) => entry?.reason !== undefined)?.reason;
    if (state === "external" && externalReason !== undefined) record.externalReason = externalReason;
    if (state === "unadopted") record = withDecision(record, scope, ["adopt", "external", "delete", "skip"]);
    if (state === "conflict" && !duplicateTarget) record = withDecision(record, scope, decisionOptions(first.kind, outputs, false));
    records.push(record);
  }
  return records;
}

async function applyCrossScopeCollisions(
  options: EngineOptions,
  scope: Scope,
  canonical: CanonicalScope,
  records: DefinitionRecord[],
  diagnostics: Diagnostic[],
): Promise<void> {
  if (scope.type !== "project") return;
  const userRoot = join(options.home, ".agents");
  await loadConfig(userRoot);
  const user = await loadCanonicalScope(userRoot, { strict: options.strict === true });
  diagnostics.push(...user.diagnostics);
  const selected = new Map<string, CanonicalSkill | CanonicalAgent>();
  for (const skill of canonical.skills) selected.set(key("skill", skill.name), skill);
  for (const agent of canonical.agents) selected.set(key("agent", agent.name), agent);
  for (const userDefinition of [...user.skills, ...user.agents]) {
    const kind: ArtifactKind = "skillFile" in userDefinition ? "skill" : "agent";
    const projectDefinition = selected.get(key(kind, userDefinition.name));
    if (projectDefinition === undefined) continue;
    const same = kind === "skill"
      ? (await compareDirectories((projectDefinition as CanonicalSkill).path, (userDefinition as CanonicalSkill).path)).equal
      : await readFile(projectDefinition.path).then((left) => readFile(userDefinition.path).then((right) => left.equals(right)));
    if (same) {
      diagnostics.push(diagnostic("info", "redundant-cross-scope-definition", `${kind} '${userDefinition.name}' is identical in user and project scope.`, userDefinition.path));
      continue;
    }
    const projectRecord = records.find((entry) => entry.kind === kind && entry.name === userDefinition.name && entry.scope === "project");
    if (projectRecord !== undefined) {
      projectRecord.state = "conflict";
      projectRecord.conflictsWith = [...new Set([...(projectRecord.conflictsWith ?? []), userDefinition.path])];
      projectRecord.evidence = "same name has different canonical content in user and project scope";
      delete projectRecord.decision;
    }
    records.push({
      kind,
      name: userDefinition.name,
      scope: "user",
      state: "conflict",
      canonical: userDefinition.path,
      evidence: "same name has different canonical content in user and project scope",
      conflictsWith: [projectDefinition.path],
    });
  }
}

function summarize(definitions: DefinitionRecord[]): SummaryRecord {
  const byState: Partial<Record<DefinitionState, number>> = {};
  for (const definition of definitions) byState[definition.state] = (byState[definition.state] ?? 0) + 1;
  return {
    total: definitions.length,
    byState,
    managed: definitions.filter((entry) => entry.canonical !== null && entry.canonical !== undefined).length,
    adoptionComplete: !definitions.some((entry) => entry.state === "unadopted"),
  };
}

function actionForDefinition(definition: DefinitionRecord): ActionRecord | undefined {
  if (definition.state === "missing") {
    const writes = definition.outputs?.filter((entry) => entry.state === "missing").map((entry) => entry.path) ?? [];
    return {
      id: `materialize-${definition.kind}-${definition.name}`,
      description: `Materialize missing ${definition.kind} '${definition.name}'.`,
      argv: ["overlord", "sync"],
      mutates: true,
      scope: definition.scope,
      reads: definition.canonical == null ? [] : [definition.canonical],
      writes,
    };
  }
  if (definition.decision !== undefined) {
    const first = definition.decision.options.find((entry) => entry !== "skip") ?? "skip";
    return {
      id: `resolve-${definition.kind}-${definition.name}`,
      description: `Resolve ${definition.state} ${definition.kind} '${definition.name}'.`,
      argv: ["overlord", "sync", "--resolve", `${definition.decision.selector}=${first}`],
      mutates: true,
      requiresConfirmation: true,
      requiresDecision: true,
      scope: definition.scope,
      reads: [definition.canonical, ...(definition.outputs?.map((entry) => entry.path) ?? [])].filter((entry): entry is string => entry != null),
      writes: definition.outputs?.map((entry) => entry.path) ?? [],
    };
  }
  return undefined;
}

async function inventory(options: EngineOptions, command: OutputDocument["command"] = "status"): Promise<InventoryContext> {
  const started = performance.now();
  const scope = await resolveScope({
    cwd: options.cwd,
    home: options.home,
    ...(options.global === undefined ? {} : { global: options.global }),
    ...(options.project === undefined ? {} : { project: options.project }),
  });
  const availability = resolveAvailability(options);
  const paths = resolveTargetPaths(scope, options);
  const diagnostics: Diagnostic[] = [];
  for (const target of ["claude", "codex"] as const) {
    if (!availability[target].available) diagnostics.push(diagnostic("warning", "target-unavailable", `${target} CLI is unavailable; its native files were left untouched.`));
  }
  const config = await loadConfig(scope.canonical);
  const canonical = await loadCanonicalScope(scope.canonical, { strict: options.strict === true });
  diagnostics.push(...canonical.diagnostics);
  const native = await scanNative(paths, availability, diagnostics);
  const { records, used } = await canonicalRecords(scope, canonical, native, config, availability, paths);
  records.push(...await nativeOnlyRecords(scope, native, used, config));
  await applyCrossScopeCollisions(options, scope, canonical, records, diagnostics);
  records.sort((left, right) => key(left.kind, left.name).localeCompare(key(right.kind, right.name)) || left.scope.localeCompare(right.scope));
  const actions = records.map(actionForDefinition).filter((entry): entry is ActionRecord => entry !== undefined);
  const attention = records.some((entry) => FAILING_STATES.has(entry.state));
  const document: OutputDocument = {
    schemaVersion: 1,
    overlordVersion: VERSION,
    command,
    status: attention ? "attention-required" : "ok",
    scope,
    targets: targetRecords(availability, paths),
    definitions: records,
    summary: summarize(records),
    actions,
    diagnostics,
    timing: { totalMs: performance.now() - started },
  };
  return { scope, paths, config, canonical, native, definitions: records, diagnostics, document };
}

export async function inspect(options: EngineOptions): Promise<OutputDocument> {
  return (await inventory(options, "status")).document;
}

function initAction(id: string, description: string, scope: Scope, writes: string[], reads: string[] = []): ActionRecord {
  return { id, description, argv: ["overlord", "init", ...(scope.type === "user" ? ["--global"] : ["--project", scope.path])], mutates: true, scope: scope.type, reads, writes };
}

async function bundledSkillSource(): Promise<string> {
  return readFile(new URL("../assets/overlord/SKILL.md", import.meta.url), "utf8");
}

export async function initialize(options: EngineOptions, init: InitializeOptions): Promise<OutputDocument> {
  const scope = await resolveScope({
    cwd: options.cwd,
    home: options.home,
    ...(options.global === undefined ? {} : { global: options.global }),
    ...(options.project === undefined ? {} : { project: options.project }),
  });
  const availability = resolveAvailability(options);
  const paths = resolveTargetPaths(scope, options);
  const diagnostics: Diagnostic[] = [];
  const actions: ActionRecord[] = [];
  const directories = [join(scope.canonical, "skills"), join(scope.canonical, "overlord", "agents")];
  const missingDirectories: string[] = [];
  for (const directory of directories) if (!(await pathExists(directory))) missingDirectories.push(directory);
  if (missingDirectories.length > 0) actions.push(initAction("initialize-directories", "Create canonical source directories.", scope, missingDirectories));
  const configuration = configPath(scope.canonical);
  if (!(await pathExists(configuration))) actions.push(initAction("initialize-config", "Create minimal Overlord configuration.", scope, [configuration]));
  if (scope.type === "user") {
    const bundled = join(scope.canonical, "skills", "overlord", "SKILL.md");
    const source = await bundledSkillSource();
    if (!(await pathExists(bundled))) actions.push(initAction("install-overlord-skill", "Install the bundled Overlord workflow skill.", scope, [bundled]));
    else if (await readFile(bundled, "utf8") !== source) {
      diagnostics.push(diagnostic("warning", "modified-bundled-skill", "The installed Overlord skill differs from this release and was not overwritten.", bundled));
    }
  } else {
    const bundled = join(options.home, ".agents", "skills", "overlord", "SKILL.md");
    if (!(await pathExists(bundled))) diagnostics.push(diagnostic("info", "global-skill-not-installed", "Run 'overlord init --global' to install the shared workflow skill.", bundled));
  }

  for (const path of new Set(actions.flatMap((action) => action.writes ?? []))) {
    await assertNoSymlinkedParent(path, scope.path);
  }

  if (!init.dryRun && actions.length > 0) {
    const release = await acquireScopeLock(scope.path);
    try {
      for (const directory of missingDirectories) await mkdir(directory, { recursive: true });
      if (!(await pathExists(configuration))) await writeFileAtomic(configuration, "version: 1\nexternal: []\n");
      if (scope.type === "user") {
        const bundled = join(scope.canonical, "skills", "overlord", "SKILL.md");
        if (!(await pathExists(bundled))) await writeFileAtomic(bundled, await bundledSkillSource());
      }
    } finally {
      await release();
    }
  }

  return {
    schemaVersion: 1,
    overlordVersion: VERSION,
    command: "init",
    status: diagnostics.some((entry) => entry.severity === "warning") ? "attention-required" : "ok",
    dryRun: init.dryRun,
    scope,
    targets: targetRecords(availability, paths),
    definitions: [],
    summary: summarize([]),
    actions,
    diagnostics,
  };
}

function canonicalByKey(context: InventoryContext): Map<string, CanonicalSkill | CanonicalAgent> {
  const definitions = new Map<string, CanonicalSkill | CanonicalAgent>();
  for (const skill of context.canonical.skills) definitions.set(key("skill", skill.name), skill);
  for (const agent of context.canonical.agents) definitions.set(key("agent", agent.name), agent);
  return definitions;
}

function nativeBoundary(context: InventoryContext, target: TargetName): string {
  if (context.scope.type === "project") return context.scope.path;
  const nativeRoot = target === "claude"
    ? dirname(context.paths.claude.skills)
    : dirname(context.paths.codex.skills);
  // Start one level above the provider root so a symlink at the configured
  // root itself is inspected rather than treated as the trusted boundary.
  return dirname(nativeRoot);
}

async function materialize(
  context: InventoryContext,
  definition: DefinitionRecord,
  canonical: CanonicalSkill | CanonicalAgent,
  nativeOutput: DefinitionOutput,
  overwrite: boolean,
): Promise<ActionRecord> {
  const backups: string[] = [];
  await assertNoSymlinkedParent(nativeOutput.path, nativeBoundary(context, nativeOutput.target));
  if (definition.kind === "skill") {
    if (nativeOutput.target === "codex" && nativeOutput.readsCanonicalDirectly === true) throw new Error("Codex canonical skills are never materialized.");
    if (overwrite) backups.push(await replaceDirectoryWithBackup(canonical.path, nativeOutput.path));
    else await copyDirectoryAtomic(canonical.path, nativeOutput.path);
  } else {
    const agent = canonical as CanonicalAgent;
    const rendered = nativeOutput.target === "claude" ? renderClaudeAgent(agent) : renderCodexAgent(agent);
    if (overwrite) backups.push(await createBackup(nativeOutput.path));
    try {
      await writeFileAtomic(nativeOutput.path, rendered);
    } catch (error) {
      if (backups.length > 0) {
        throw withCompletedActions(error, [{
          id: `backup-before-failed-replace-agent-${definition.name}-${nativeOutput.target}`,
          description: `Created a recoverable backup before replacement of ${nativeOutput.target} agent '${definition.name}' failed.`,
          argv: ["overlord", "sync"],
          mutates: true,
          scope: definition.scope,
          reads: [nativeOutput.path],
          writes: backups,
          backups,
        }]);
      }
      throw error;
    }
  }
  const action: ActionRecord = {
    id: `${overwrite ? "replace" : "materialize"}-${definition.kind}-${definition.name}-${nativeOutput.target}`,
    description: `${overwrite ? "Replaced" : "Materialized"} ${definition.kind} '${definition.name}' for ${nativeOutput.target}.`,
    argv: ["overlord", "sync"],
    mutates: true,
    scope: definition.scope,
    reads: [canonical.path],
    writes: [nativeOutput.path],
  };
  if (backups.length > 0) action.backups = backups;
  return action;
}

function resolutionMatches(raw: string, definition: DefinitionRecord, scope: Scope): boolean {
  const full = definition.decision?.selector;
  if (raw === full) return true;
  const kindAndName = `${definition.kind}:${definition.name}`;
  if (raw === kindAndName || raw === definition.name) return true;
  const atIndex = raw.indexOf("@");
  if (atIndex > 0 && raw.slice(0, atIndex) === definition.name) {
    const rawScope = raw.slice(atIndex + 1);
    if (rawScope === (definition.scope === "user" ? "user" : scope.path)) return true;
    if (rawScope === definition.scope) return true;
  }
  if (raw === `${kindAndName}@${definition.scope}`) return true;
  if (scope.type === "project" && raw === `${kindAndName}@project` && definition.scope === "project") return true;
  return false;
}

function resolveDecisions(context: InventoryContext, resolutions: Readonly<Record<string, ResolutionSide>>): Map<string, ResolutionSide> {
  const decisions = context.definitions.filter((entry) => entry.decision !== undefined);
  const resolved = new Map<string, ResolutionSide>();
  for (const [rawSelector, side] of Object.entries(resolutions)) {
    const matches = decisions.filter((entry) => resolutionMatches(rawSelector, entry, context.scope));
    if (matches.length !== 1) {
      const detail = matches.length === 0
        ? "no outstanding decision matches"
        : `matches ${matches.map((entry) => entry.decision!.selector).join(", ")}`;
      throw Object.assign(new Error(`Invalid resolution selector '${rawSelector}': ${detail}.`), { code: "usage" });
    }
    const definition = matches[0]!;
    if (!definition.decision!.options.includes(side)) {
      throw Object.assign(new Error(`Resolution '${side}' is not valid for ${definition.decision!.selector}; choose ${definition.decision!.options.join(", ")}.`), { code: "usage" });
    }
    resolved.set(definition.decision!.selector, side);
  }
  return resolved;
}

function nativeForRecord(context: InventoryContext, definition: DefinitionRecord): NativeDefinition[] {
  const paths = new Set(
    definition.outputs
      ?.filter((entry) => entry.state !== "external")
      .map((entry) => resolve(entry.path)) ?? [],
  );
  return context.native.filter((entry) => paths.has(resolve(entry.path)));
}

function isExpectedAgentOutput(
  context: InventoryContext,
  name: string,
  nativeOutput: DefinitionOutput,
): boolean {
  const extension = nativeOutput.target === "claude" ? "md" : "toml";
  return resolve(nativeOutput.path) === resolve(join(context.paths[nativeOutput.target].agents, `${name}.${extension}`));
}

function plannedResolvedAction(context: InventoryContext, definition: DefinitionRecord, side: ResolutionSide): ActionRecord {
  const entries = nativeForRecord(context, definition);
  const canonicalDestination = definition.kind === "skill"
    ? join(context.scope.canonical, "skills", definition.name)
    : join(context.scope.canonical, "overlord", "agents", `${definition.name}.md`);
  const action: ActionRecord = {
    id: `plan-${side}-${definition.kind}-${definition.name}`,
    description: `Apply '${side}' to ${definition.state} ${definition.kind} '${definition.name}'.`,
    argv: ["overlord", "sync", "--resolve", `${definition.decision!.selector}=${side}`],
    mutates: side !== "skip",
    requiresDecision: false,
    requiresConfirmation: side === "delete",
    scope: definition.scope,
    reads: [definition.canonical, ...entries.map((entry) => entry.path)].filter((entry): entry is string => entry != null),
    writes: [],
    removes: [],
  };
  if (side === "delete") {
    action.removes = entries.map((entry) => entry.path);
  } else if (side === "external") {
    action.writes = [configPath(context.scope.canonical)];
  } else if (side === "adopt" || side === "claude" || side === "codex") {
    if (definition.kind === "agent") {
      const canonical = canonicalByKey(context).get(key(definition.kind, definition.name)) as CanonicalAgent | undefined;
      const preferred = side === "adopt" ? undefined : side;
      const adopted = mergedNativeAgent(entries, preferred, canonical);
      const available = new Set(
        context.document.targets
          ?.filter((target) => target.available)
          .map((target) => target.name) ?? [],
      );
      const nativeDestinations = (["claude", "codex"] as const)
        .filter((target) => available.has(target) && adopted.targets[target] !== false)
        .map((target) => join(
          context.paths[target].agents,
          `${definition.name}.${target === "claude" ? "md" : "toml"}`,
        ));
      action.writes = [...new Set([canonicalDestination, ...nativeDestinations])];
    } else {
      action.writes = [
        canonicalDestination,
        ...(definition.outputs
          ?.filter((entry) => entry.target !== side && entry.readsCanonicalDirectly !== true)
          .map((entry) => entry.path) ?? []),
      ];
    }
    if (definition.kind === "skill") action.removes = entries.filter((entry) => entry.scanOnly === true).map((entry) => entry.path);
    else action.removes = definition.outputs
      ?.filter((entry) => !isExpectedAgentOutput(context, definition.name, entry) && entry.state !== "external")
      .map((entry) => entry.path) ?? [];
  } else if (side === "agents") {
    action.writes = definition.outputs
      ?.filter((entry) =>
        entry.readsCanonicalDirectly !== true
        && !(definition.kind === "skill" && entry.target === "codex")
        && (definition.kind !== "agent" || isExpectedAgentOutput(context, definition.name, entry)),
      )
      .map((entry) => entry.path) ?? [];
    if (definition.kind === "skill") action.removes = entries.filter((entry) => entry.scanOnly === true).map((entry) => entry.path);
    else action.removes = definition.outputs
      ?.filter((entry) => !isExpectedAgentOutput(context, definition.name, entry) && entry.state !== "external")
      .map((entry) => entry.path) ?? [];
  }
  return action;
}

function mergedNativeAgent(entries: NativeDefinition[], preferred?: TargetName, current?: CanonicalAgent): CanonicalAgent {
  const source = (preferred === undefined ? undefined : entries.find((entry) => entry.target === preferred)) ?? entries[0];
  if (source?.agent === undefined) throw Object.assign(new Error("Native agent cannot be adopted because it is invalid."), { code: "usage" });
  const targets: CanonicalAgent["targets"] = {
    claude: current?.targets.claude ?? {},
    codex: current?.targets.codex ?? {},
  };
  for (const entry of entries) {
    if (entry.agent === undefined) continue;
    targets[entry.target] = entry.agent.targets[entry.target];
  }
  return { ...source.agent, path: current?.path ?? source.agent.path, targets, valid: true };
}

async function installCanonicalAgent(context: InventoryContext, agent: CanonicalAgent, overwrite: boolean): Promise<ActionRecord> {
  const path = join(context.scope.canonical, "overlord", "agents", `${agent.name}.md`);
  const backups: string[] = [];
  await assertNoSymlinkedParent(path, context.scope.path);
  if (overwrite && await pathExists(path)) backups.push(await createBackup(path));
  try {
    await writeFileAtomic(path, renderCanonicalAgent({ ...agent, path }));
  } catch (error) {
    if (backups.length > 0) {
      throw withCompletedActions(error, [{
        id: `backup-before-failed-canonical-agent-${agent.name}`,
        description: `Created a recoverable backup before replacement of canonical agent '${agent.name}' failed.`,
        argv: ["overlord", "sync"],
        mutates: true,
        scope: context.scope.type,
        reads: [path],
        writes: backups,
        backups,
      }]);
    }
    throw error;
  }
  const action: ActionRecord = {
    id: `${overwrite ? "replace" : "adopt"}-canonical-agent-${agent.name}`,
    description: `${overwrite ? "Replaced" : "Adopted"} canonical agent '${agent.name}'.`,
    argv: ["overlord", "sync"],
    mutates: true,
    scope: context.scope.type,
    reads: [agent.path],
    writes: [path],
  };
  if (backups.length > 0) action.backups = backups;
  return action;
}

async function installCanonicalSkill(context: InventoryContext, source: NativeDefinition, overwrite: boolean): Promise<ActionRecord> {
  const destination = join(context.scope.canonical, "skills", source.name);
  const backups: string[] = [];
  await assertNoSymlinkedParent(destination, context.scope.path);
  if (source.scanOnly === true) {
    await assertNoSymlinkedParent(source.path, nativeBoundary(context, source.target));
  }
  const verifiedSource = await realpath(source.path);
  await compareDirectories(verifiedSource, verifiedSource);
  let installed = false;
  try {
    if (overwrite && await pathExists(destination)) backups.push(await replaceDirectoryWithBackup(verifiedSource, destination));
    else await copyDirectoryAtomic(verifiedSource, destination);
    installed = true;
    if (source.scanOnly === true) {
      const comparison = await compareDirectories(destination, verifiedSource);
      if (!comparison.equal) throw new Error(`Adoption verification failed: ${comparison.evidence ?? "directory differs"}`);
      backups.push(await removeWithBackup(source.path));
    }
  } catch (error) {
    const completed: ActionRecord[] = [];
    if (installed) {
      const installAction: ActionRecord = {
        id: `partial-${overwrite ? "replace" : "adopt"}-canonical-skill-${source.name}`,
        description: `Installed canonical skill '${source.name}' before removal of its native source failed.`,
        argv: ["overlord", "sync"],
        mutates: true,
        scope: context.scope.type,
        reads: [source.path],
        writes: [destination],
      };
      if (backups.length > 0) installAction.backups = [...backups];
      completed.push(installAction);
    }
    const failedRemovalBackups = createdBackups(error);
    if (failedRemovalBackups.length > 0) {
      completed.push({
        id: `backup-before-failed-adoption-remove-skill-${source.name}`,
        description: `Created a recoverable backup before removal of scan-only skill '${source.name}' failed.`,
        argv: ["overlord", "sync"],
        mutates: true,
        scope: context.scope.type,
        reads: [source.path],
        writes: failedRemovalBackups,
        backups: failedRemovalBackups,
      });
    }
    throw withCompletedActions(error, completed);
  }
  const action: ActionRecord = {
    id: `${overwrite ? "replace" : "adopt"}-canonical-skill-${source.name}`,
    description: `${overwrite ? "Replaced" : "Adopted"} canonical skill '${source.name}'.`,
    argv: ["overlord", "sync"],
    mutates: true,
    scope: context.scope.type,
    reads: [source.path],
    writes: [destination],
  };
  if (source.scanOnly === true) action.removes = [source.path];
  if (backups.length > 0) action.backups = backups;
  return action;
}

async function recordExternal(context: InventoryContext, entries: NativeDefinition[]): Promise<ActionRecord> {
  let config = context.config;
  const additions: ExternalEntry[] = [];
  for (const entry of entries) {
    const external: ExternalEntry = { kind: entry.kind, name: entry.name };
    if (entry.kind === "agent" || entries.length === 1) external.target = entry.target;
    additions.push(external);
  }
  for (const addition of additions) config = addExternal(config, addition);
  await assertNoSymlinkedParent(configPath(context.scope.canonical), context.scope.path);
  await mkdir(join(context.scope.canonical, "overlord"), { recursive: true });
  await writeFileAtomic(configPath(context.scope.canonical), renderConfig(config));
  context.config = config;
  return {
    id: `external-${entries[0]!.kind}-${entries[0]!.name}`,
    description: `Recorded ${entries[0]!.kind} '${entries[0]!.name}' as externally managed.`,
    argv: ["overlord", "sync"],
    mutates: true,
    scope: context.scope.type,
    reads: entries.map((entry) => entry.path),
    writes: [configPath(context.scope.canonical)],
  };
}

async function deleteNative(context: InventoryContext, definition: DefinitionRecord, entries: NativeDefinition[]): Promise<ActionRecord[]> {
  for (const entry of entries) {
    await assertNoSymlinkedParent(entry.path, nativeBoundary(context, entry.target));
  }
  const actions: ActionRecord[] = [];
  for (const entry of entries) {
    try {
      const backup = await removeWithBackup(entry.path);
      actions.push({
        id: `delete-${definition.kind}-${definition.name}-${entry.target}-${actions.length + 1}`,
        description: `Deleted native ${entry.target} ${definition.kind} '${definition.name}' after retaining a recoverable backup.`,
        argv: ["overlord", "sync"],
        mutates: true,
        requiresConfirmation: true,
        scope: context.scope.type,
        reads: [entry.path],
        removes: [entry.path],
        backups: [backup],
      });
    } catch (error) {
      const backups = createdBackups(error);
      if (backups.length > 0) {
        actions.push({
          id: `backup-before-failed-delete-${definition.kind}-${definition.name}-${entry.target}`,
          description: `Created a recoverable backup before deletion of ${entry.target} ${definition.kind} '${definition.name}' failed.`,
          argv: ["overlord", "sync"],
          mutates: true,
          requiresConfirmation: true,
          scope: context.scope.type,
          reads: [entry.path],
          writes: backups,
          backups,
        });
      }
      throw withCompletedActions(error, actions);
    }
  }
  return actions;
}

async function forceCanonicalOutputs(
  options: EngineOptions,
  definitionKind: ArtifactKind,
  name: string,
  preferred?: TargetName,
): Promise<ActionRecord[]> {
  const refreshed = await inventory(options, "sync");
  const definition = refreshed.definitions.find((entry) => entry.kind === definitionKind && entry.name === name && entry.scope === refreshed.scope.type);
  const canonical = canonicalByKey(refreshed).get(key(definitionKind, name));
  if (definition === undefined || canonical === undefined) return [];
  const actions: ActionRecord[] = [];
  try {
    for (const nativeOutput of definition.outputs ?? []) {
      if (nativeOutput.readsCanonicalDirectly === true) continue;
      // A chosen skill tree is already byte-identical to the canonical copy. An
      // agent file, however, may use provider-valid formatting that the
      // deterministic renderer normalizes, so the chosen target must be brought
      // back to the rendered bytes as part of the same resolution.
      if (definitionKind === "skill" && nativeOutput.target === preferred) continue;
      if (definitionKind === "agent" && !isExpectedAgentOutput(refreshed, name, nativeOutput)) {
        if (nativeOutput.state !== "conflict" && nativeOutput.state !== "unadopted") continue;
        await assertNoSymlinkedParent(nativeOutput.path, nativeBoundary(refreshed, nativeOutput.target));
        const backup = await removeWithBackup(nativeOutput.path);
        actions.push({
          id: `remove-duplicate-agent-${name}-${nativeOutput.target}`,
          description: `Removed duplicate ${nativeOutput.target} agent '${name}' outside its canonical output path.`,
          argv: ["overlord", "sync"],
          mutates: true,
          scope: refreshed.scope.type,
          reads: [nativeOutput.path],
          removes: [nativeOutput.path],
          backups: [backup],
        });
        continue;
      }
      if (definitionKind === "skill" && nativeOutput.target === "codex" && nativeOutput.state === "conflict") {
        await assertNoSymlinkedParent(nativeOutput.path, nativeBoundary(refreshed, nativeOutput.target));
        const backup = await removeWithBackup(nativeOutput.path);
        actions.push({
          id: `remove-duplicate-skill-${name}`,
          description: `Removed duplicate Codex scan-only skill '${name}'.`,
          argv: ["overlord", "sync"],
          mutates: true,
          scope: refreshed.scope.type,
          reads: [nativeOutput.path],
          removes: [nativeOutput.path],
          backups: [backup],
        });
        continue;
      }
      if (nativeOutput.state === "missing") actions.push(await materialize(refreshed, definition, canonical, nativeOutput, false));
      else if (nativeOutput.state === "conflict") actions.push(await materialize(refreshed, definition, canonical, nativeOutput, true));
    }
  } catch (error) {
    throw withCompletedActions(error, actions);
  }
  return actions;
}

async function applyDecision(
  options: EngineOptions,
  context: InventoryContext,
  definition: DefinitionRecord,
  side: ResolutionSide,
  sync: SyncOptions,
): Promise<ActionRecord[]> {
  if (side === "skip") return [];
  const entries = nativeForRecord(context, definition);
  if (side === "external") return [await recordExternal(context, entries)];
  if (side === "delete") {
    if (sync.confirmDestructive !== true) throw Object.assign(new Error(`Deleting ${definition.kind} '${definition.name}' requires explicit destructive confirmation.`), { code: "usage" });
    return deleteNative(context, definition, entries);
  }

  const canonical = canonicalByKey(context).get(key(definition.kind, definition.name));
  if (side === "adopt") {
    if (definition.kind === "skill") {
      const source = entries.find((entry) => entry.target === "claude") ?? entries[0];
      if (source === undefined || !source.valid) throw Object.assign(new Error("Invalid native skill cannot be adopted without a portable rename."), { code: "usage" });
      const action = await installCanonicalSkill(context, source, false);
      try {
        return [action, ...await forceCanonicalOutputs(options, "skill", definition.name, source.scanOnly === true ? undefined : source.target)];
      } catch (error) {
        throw withCompletedActions(error, [action]);
      }
    }
    const adopted = mergedNativeAgent(entries, undefined, canonical as CanonicalAgent | undefined);
    const action = await installCanonicalAgent(context, adopted, canonical !== undefined);
    try {
      return [action, ...await forceCanonicalOutputs(options, "agent", definition.name)];
    } catch (error) {
      throw withCompletedActions(error, [action]);
    }
  }

  if (side === "agents") {
    if (canonical === undefined) throw Object.assign(new Error("No canonical definition exists for the 'agents' resolution."), { code: "usage" });
    return forceCanonicalOutputs(options, definition.kind, definition.name);
  }

  const preferred = side as TargetName;
  const source = entries.find((entry) => entry.target === preferred);
  if (source === undefined) throw Object.assign(new Error(`No ${preferred} copy exists for '${definition.name}'.`), { code: "usage" });
  if (definition.kind === "skill") {
    if (!source.valid) throw Object.assign(new Error("Invalid native skill cannot replace canonical without a portable rename."), { code: "usage" });
    const action = await installCanonicalSkill(context, source, canonical !== undefined);
    try {
      return [action, ...await forceCanonicalOutputs(options, "skill", definition.name, preferred)];
    } catch (error) {
      throw withCompletedActions(error, [action]);
    }
  }
  const adopted = mergedNativeAgent(entries, preferred, canonical as CanonicalAgent | undefined);
  const action = await installCanonicalAgent(context, adopted, canonical !== undefined);
  try {
    return [action, ...await forceCanonicalOutputs(options, "agent", definition.name, preferred)];
  } catch (error) {
    throw withCompletedActions(error, [action]);
  }
}

async function materializeMissing(context: InventoryContext): Promise<ActionRecord[]> {
  const definitions = canonicalByKey(context);
  const actions: ActionRecord[] = [];
  try {
    for (const record of context.definitions) {
      if (record.scope !== context.scope.type || record.canonical == null) continue;
      if (record.state === "conflict" && record.decision === undefined) continue;
      const canonical = definitions.get(key(record.kind, record.name));
      if (canonical === undefined || !canonical.valid) continue;
      for (const nativeOutput of record.outputs ?? []) {
        if (nativeOutput.state === "missing") actions.push(await materialize(context, record, canonical, nativeOutput, false));
      }
    }
  } catch (error) {
    throw withCompletedActions(error, actions);
  }
  return actions;
}

function blocksMutation(context: InventoryContext): boolean {
  if ([...context.canonical.skills, ...context.canonical.agents].some((entry) => !entry.valid)) return true;
  return context.definitions.some((entry) =>
    entry.scope === context.scope.type
    && entry.canonical != null
    && entry.state === "invalid",
  );
}

export async function synchronize(options: EngineOptions, sync: SyncOptions): Promise<OutputDocument> {
  const initial = await inventory(options, "sync");
  initial.document.dryRun = sync.dryRun;
  const resolutions = resolveDecisions(initial, sync.resolutions);
  if (sync.dryRun) {
    initial.document.actions = initial.definitions.flatMap((definition) => {
      const decision = definition.decision;
      if (decision === undefined) return actionForDefinition(definition) ?? [];
      const side = resolutions.get(decision.selector);
      return side === undefined ? actionForDefinition(definition) ?? [] : plannedResolvedAction(initial, definition, side);
    });
    return initial.document;
  }
  if (blocksMutation(initial)) return initial.document;

  const release = await acquireScopeLock(initial.scope.path);
  const completed: ActionRecord[] = [];
  try {
    // Inventory and selector validation are repeated after acquiring the lock.
    // The pre-lock snapshot is useful for fast feedback, but must never drive a
    // mutation after another process had a chance to change the scope.
    const locked = await inventory(options, "sync");
    locked.document.dryRun = false;
    const lockedResolutions = resolveDecisions(locked, sync.resolutions);
    if (blocksMutation(locked)) return locked.document;

    completed.push(...await materializeMissing(locked));
    for (const definition of locked.definitions) {
      const decision = definition.decision;
      if (decision === undefined) continue;
      const side = lockedResolutions.get(decision.selector);
      if (side === undefined) continue;
      completed.push(...await applyDecision(options, locked, definition, side, sync));
    }
    const afterDecisions = await inventory(options, "sync");
    completed.push(...await materializeMissing(afterDecisions));
    const final = (await inventory(options, "sync")).document;
    final.dryRun = false;
    if (completed.length > 0) final.actions = [...completed, ...(final.actions ?? [])];
    return final;
  } catch (error) {
    throw withCompletedActions(error, completed);
  } finally {
    await release();
  }
}
