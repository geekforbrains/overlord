import { join } from "node:path";

import { compareDirectories, pathExists } from "./filesystem.js";
import { digestFile, digestSkillTree, getLedgerEntry, type LedgerEndpoint, type LedgerEntry, type LedgerReceipt, type ScopeLedger } from "./ledger.js";
import type { NativeDefinition } from "./native.js";
import { renderClaudeAgent, renderCodexAgent } from "./render.js";
import type {
  ArtifactKind,
  CanonicalAgent,
  CanonicalScope,
  CanonicalSkill,
  DefinitionOutput,
  DefinitionRecord,
  DefinitionState,
  Scope,
  TargetName,
} from "./types.js";
import type { TargetPaths } from "./targets.js";

export type SideDelta = "absent" | "unchanged" | "added" | "modified" | "deleted";
export type ReconciliationSource = "none" | "canonical" | "claude" | "codex" | "merged-native" | "delete" | "conflict" | "invalid";

export interface EndpointSide {
  endpoint: LedgerEndpoint;
  path: string;
  present: boolean;
  valid: boolean;
  digest?: string;
  delta: SideDelta;
  native?: NativeDefinition;
}

export interface ProviderOperation {
  target: TargetName;
  operation: "write" | "remove";
  path: string;
}

export interface ReconciliationPlan {
  kind: ArtifactKind;
  name: string;
  canonicalPath: string;
  canonical?: CanonicalSkill | CanonicalAgent;
  desiredAgent?: CanonicalAgent;
  sourcePath?: string;
  sides: Record<LedgerEndpoint, EndpointSide>;
  baseline?: LedgerEntry;
  source: ReconciliationSource;
  state: DefinitionState;
  evidence?: string;
  conflictsWith?: string[];
  canonicalOperation: "none" | "write" | "remove";
  providerOperations: ProviderOperation[];
  canRecordBaseline: boolean;
}

interface PlannerInput {
  scope: Scope;
  paths: TargetPaths;
  canonical: CanonicalScope;
  native: NativeDefinition[];
  ledger: ScopeLedger;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function definitionKey(kind: ArtifactKind, name: string): string {
  return `${kind}:${name}`;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "darwin"
    ? value.normalize("NFD").toLowerCase()
    : value;
  return normalize(left) === normalize(right);
}

function expectedCanonicalPath(scope: Scope, kind: ArtifactKind, name: string): string {
  return kind === "skill"
    ? join(scope.canonical, "skills", name)
    : join(scope.canonical, "overlord", "agents", `${name}.md`);
}

function expectedProviderPath(paths: TargetPaths, kind: ArtifactKind, name: string, target: TargetName): string {
  if (kind === "skill") return join(paths.claude.skills, name);
  return join(paths[target].agents, `${name}.${target === "claude" ? "md" : "toml"}`);
}

function receiptFor(entry: LedgerEntry | undefined, endpoint: LedgerEndpoint): LedgerReceipt | undefined {
  return entry?.receipts[endpoint];
}

function sideDelta(side: Omit<EndpointSide, "delta">, receipt: LedgerReceipt | undefined): SideDelta {
  if (receipt === undefined || !samePath(receipt.path, side.path)) return side.present ? "added" : "absent";
  if (!side.present) return "deleted";
  return side.digest === receipt.digest ? "unchanged" : "modified";
}

function withDelta(side: Omit<EndpointSide, "delta">, receipt: LedgerReceipt | undefined): EndpointSide {
  return { ...side, delta: sideDelta(side, receipt) };
}

function changed(delta: SideDelta): boolean {
  return delta === "added" || delta === "modified" || delta === "deleted";
}

function deleted(delta: SideDelta): boolean {
  return delta === "deleted";
}

function nativeCandidates(
  native: readonly NativeDefinition[],
  kind: ArtifactKind,
  name: string,
  target: TargetName,
): NativeDefinition[] {
  return native.filter((entry) => entry.kind === kind && entry.name === name && entry.target === target);
}

function chooseNative(
  candidates: readonly NativeDefinition[],
  expectedPath: string,
  receipt: LedgerReceipt | undefined,
): NativeDefinition | undefined {
  if (candidates.length === 0) return undefined;
  const receiptMatch = receipt === undefined ? undefined : candidates.find((entry) => samePath(entry.path, receipt.path));
  if (receiptMatch !== undefined) return receiptMatch;
  return candidates.find((entry) => samePath(entry.path, expectedPath)) ?? candidates[0];
}

async function canonicalSide(
  kind: ArtifactKind,
  path: string,
  definition: CanonicalSkill | CanonicalAgent | undefined,
  baseline: LedgerEntry | undefined,
): Promise<EndpointSide> {
  const partial: Omit<EndpointSide, "delta"> = definition === undefined
    ? { endpoint: "canonical", path, present: false, valid: true }
    : { endpoint: "canonical", path: definition.path, present: true, valid: definition.valid };
  if (definition?.valid === true) {
    partial.digest = await (kind === "skill" ? digestSkillTree(definition.path) : digestFile(definition.path));
  }
  return withDelta(partial, receiptFor(baseline, "canonical"));
}

async function providerSide(
  kind: ArtifactKind,
  target: TargetName,
  expectedPath: string,
  candidates: readonly NativeDefinition[],
  baseline: LedgerEntry | undefined,
): Promise<EndpointSide> {
  const receipt = receiptFor(baseline, target);
  const selected = chooseNative(candidates, expectedPath, receipt);
  const partial: Omit<EndpointSide, "delta"> = selected === undefined
    ? { endpoint: target, path: expectedPath, present: false, valid: true }
    : { endpoint: target, path: selected.path, present: true, valid: selected.valid, native: selected };
  if (selected?.valid === true) {
    partial.digest = await (kind === "skill" ? digestSkillTree(selected.path) : digestFile(selected.path));
  }
  return withDelta(partial, receipt);
}

function blankSide(endpoint: LedgerEndpoint, path: string): EndpointSide {
  return { endpoint, path, present: false, valid: true, delta: "absent" };
}

function commonAgentEqual(left: CanonicalAgent, right: CanonicalAgent): boolean {
  const normalize = (value: string) => `${value.replace(/\r\n?/g, "\n").replace(/\n+$/g, "")}\n`;
  return left.name === right.name
    && left.description === right.description
    && normalize(left.body) === normalize(right.body);
}

function nativeMatchesCanonical(native: NativeDefinition, canonical: CanonicalAgent, target: TargetName): boolean {
  if (native.source === undefined) return false;
  try {
    return native.source === (target === "claude" ? renderClaudeAgent(canonical) : renderCodexAgent(canonical));
  } catch {
    return false;
  }
}

function mergedNativeAgent(canonical: CanonicalAgent | undefined, natives: NativeDefinition[]): CanonicalAgent | undefined {
  const parsed = natives.filter((entry): entry is NativeDefinition & { agent: CanonicalAgent } => entry.agent !== undefined);
  const first = parsed[0]?.agent;
  if (first === undefined || parsed.some((entry) => !commonAgentEqual(first, entry.agent))) return undefined;
  const targets: CanonicalAgent["targets"] = canonical === undefined
    ? { claude: {}, codex: {} }
    : { ...canonical.targets };
  for (const entry of parsed) targets[entry.target] = entry.agent.targets[entry.target];
  return { ...first, path: canonical?.path ?? first.path, targets, valid: true };
}

function providerOperationsForAgent(
  plan: Pick<ReconciliationPlan, "sides">,
  agent: CanonicalAgent,
  writeEnabled: boolean,
): ProviderOperation[] {
  const operations: ProviderOperation[] = [];
  for (const target of ["claude", "codex"] as const) {
    const side = plan.sides[target];
    if (agent.targets[target] === false) {
      if (side.present) operations.push({ target, operation: "remove", path: side.path });
    } else if (writeEnabled || !side.present) {
      operations.push({ target, operation: "write", path: side.path });
    }
  }
  return operations;
}

async function buildSkillPlan(
  input: PlannerInput,
  name: string,
  canonical: CanonicalSkill | undefined,
  baseline: LedgerEntry | undefined,
): Promise<ReconciliationPlan> {
  const canonicalPath = expectedCanonicalPath(input.scope, "skill", name);
  const claudeExpected = expectedProviderPath(input.paths, "skill", name, "claude");
  const candidates = nativeCandidates(input.native, "skill", name, "claude");
  const sides = {
    canonical: await canonicalSide("skill", canonicalPath, canonical, baseline),
    claude: await providerSide("skill", "claude", claudeExpected, candidates, baseline),
    codex: blankSide("codex", canonical?.path ?? canonicalPath),
  } satisfies Record<LedgerEndpoint, EndpointSide>;
  const base: ReconciliationPlan = {
    kind: "skill",
    name,
    canonicalPath,
    sides,
    source: "none",
    state: "synced",
    canonicalOperation: "none",
    providerOperations: [],
    canRecordBaseline: false,
  };
  if (canonical !== undefined) base.canonical = canonical;
  if (baseline !== undefined) base.baseline = baseline;

  if (candidates.length > 1) {
    return {
      ...base,
      source: "conflict",
      state: "conflict",
      evidence: "multiple Claude skills use the same name",
      conflictsWith: candidates.map((entry) => entry.path),
    };
  }
  if ((canonical !== undefined && !canonical.valid) || (sides.claude.present && !sides.claude.valid)) {
    const evidence = canonical !== undefined && !canonical.valid
      ? "canonical skill is invalid"
      : sides.claude.native?.evidence ?? "Claude skill is invalid";
    return {
      ...base,
      source: "invalid",
      state: "invalid",
      evidence,
    };
  }

  const bothPresent = sides.canonical.present && sides.claude.present;
  const equal = bothPresent && canonical !== undefined
    ? (await compareDirectories(canonical.path, sides.claude.path)).equal
    : false;
  if (baseline === undefined) {
    if (bothPresent && !equal) {
      return { ...base, source: "conflict", state: "conflict", evidence: "canonical and Claude skills differ without a common baseline", conflictsWith: [canonicalPath, sides.claude.path] };
    }
    if (bothPresent) return { ...base, canRecordBaseline: true };
    if (sides.canonical.present) {
      return {
        ...base,
        source: "canonical",
        state: "missing",
        providerOperations: [{ target: "claude", operation: "write", path: sides.claude.path }],
      };
    }
    if (sides.claude.present) {
      return {
        ...base,
        source: "claude",
        state: "changed",
        sourcePath: sides.claude.path,
        canonicalOperation: "write",
      };
    }
    return base;
  }

  const changedSides = [sides.canonical, sides.claude].filter((side) => changed(side.delta));
  if (changedSides.length === 0) {
    if (sides.canonical.present && !sides.claude.present) {
      return { ...base, source: "canonical", state: "missing", providerOperations: [{ target: "claude", operation: "write", path: sides.claude.path }] };
    }
    return base;
  }
  if (changedSides.length === 1) {
    const side = changedSides[0]!;
    if (deleted(side.delta)) {
      return {
        ...base,
        source: "delete",
        state: "changed",
        canonicalOperation: sides.canonical.present ? "remove" : "none",
        providerOperations: sides.claude.present ? [{ target: "claude", operation: "remove", path: sides.claude.path }] : [],
      };
    }
    if (side.endpoint === "canonical") {
      return { ...base, source: "canonical", state: "changed", providerOperations: [{ target: "claude", operation: "write", path: sides.claude.path }] };
    }
    return { ...base, source: "claude", state: "changed", sourcePath: sides.claude.path, canonicalOperation: "write" };
  }
  if (changedSides.every((side) => deleted(side.delta))) {
    return { ...base, source: "delete", state: "changed", canonicalOperation: "none", providerOperations: [] };
  }
  if (equal) return { ...base, canRecordBaseline: true };
  return {
    ...base,
    source: "conflict",
    state: "conflict",
    evidence: "canonical and Claude skill changes are incompatible",
    conflictsWith: [canonicalPath, sides.claude.path],
  };
}

function expectedAgentMatchesAll(plan: ReconciliationPlan, canonical: CanonicalAgent): boolean {
  for (const target of ["claude", "codex"] as const) {
    const side = plan.sides[target];
    if (canonical.targets[target] === false) {
      if (side.present) return false;
    } else if (side.present && (side.native === undefined || !nativeMatchesCanonical(side.native, canonical, target))) {
      return false;
    }
  }
  return true;
}

async function buildAgentPlan(
  input: PlannerInput,
  name: string,
  canonical: CanonicalAgent | undefined,
  baseline: LedgerEntry | undefined,
): Promise<ReconciliationPlan> {
  const canonicalPath = expectedCanonicalPath(input.scope, "agent", name);
  const candidates: Record<TargetName, NativeDefinition[]> = {
    claude: nativeCandidates(input.native, "agent", name, "claude"),
    codex: nativeCandidates(input.native, "agent", name, "codex"),
  };
  for (const target of ["claude", "codex"] as const) {
    const expectedPath = expectedProviderPath(input.paths, "agent", name, target);
    if (candidates[target].length === 0 && await pathExists(expectedPath)) {
      const aliased = input.native.find((entry) => entry.kind === "agent"
        && entry.target === target
        && samePath(entry.path, expectedPath));
      if (aliased !== undefined) candidates[target].push(aliased);
    }
  }
  const sides = {
    canonical: await canonicalSide("agent", canonicalPath, canonical, baseline),
    claude: await providerSide("agent", "claude", expectedProviderPath(input.paths, "agent", name, "claude"), candidates.claude, baseline),
    codex: await providerSide("agent", "codex", expectedProviderPath(input.paths, "agent", name, "codex"), candidates.codex, baseline),
  } satisfies Record<LedgerEndpoint, EndpointSide>;
  const base: ReconciliationPlan = {
    kind: "agent",
    name,
    canonicalPath,
    sides,
    source: "none",
    state: "synced",
    canonicalOperation: "none",
    providerOperations: [],
    canRecordBaseline: false,
  };
  if (canonical !== undefined) base.canonical = canonical;
  if (baseline !== undefined) base.baseline = baseline;

  const duplicates = [...candidates.claude, ...candidates.codex].filter((entry) => {
    const group = entry.target === "claude" ? candidates.claude : candidates.codex;
    return group.length > 1;
  });
  if (duplicates.length > 0) {
    return { ...base, source: "conflict", state: "conflict", evidence: "multiple native agents use the same name in one target", conflictsWith: duplicates.map((entry) => entry.path) };
  }
  if ((canonical !== undefined && !canonical.valid) || [sides.claude, sides.codex].some((side) => side.present && !side.valid)) {
    const invalidNative = [sides.claude, sides.codex].find((side) => side.present && !side.valid);
    const evidence = canonical !== undefined && !canonical.valid
      ? "canonical agent is invalid"
      : invalidNative?.native?.evidence ?? "native agent is invalid";
    return { ...base, source: "invalid", state: "invalid", evidence };
  }
  if (canonical !== undefined) {
    try {
      if (canonical.targets.claude !== false) renderClaudeAgent(canonical);
      if (canonical.targets.codex !== false) renderCodexAgent(canonical);
    } catch (error) {
      return {
        ...base,
        source: "invalid",
        state: "invalid",
        evidence: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (baseline === undefined) {
    if (canonical !== undefined) {
      const conflicts = (["claude", "codex"] as const).filter((target) => {
        const side = sides[target];
        if (canonical.targets[target] === false) return side.present;
        return side.present && (side.native === undefined || !nativeMatchesCanonical(side.native, canonical, target));
      });
      const safeWrites = (["claude", "codex"] as const)
        .filter((target) => canonical.targets[target] !== false && !sides[target].present)
        .map((target): ProviderOperation => ({ target, operation: "write", path: sides[target].path }));
      if (conflicts.length > 0) {
        return {
          ...base,
          source: "conflict",
          state: "conflict",
          evidence: `canonical and ${conflicts.join(" and ")} agent content differ without a common baseline`,
          conflictsWith: conflicts.map((target) => sides[target].path),
          providerOperations: safeWrites,
        };
      }
      return {
        ...base,
        source: safeWrites.length > 0 ? "canonical" : "none",
        state: safeWrites.length > 0 ? "missing" : "synced",
        providerOperations: safeWrites,
        canRecordBaseline: safeWrites.length === 0,
      };
    }

    const presentNatives = [sides.claude, sides.codex]
      .filter((side): side is EndpointSide & { native: NativeDefinition } => side.native !== undefined)
      .map((side) => side.native);
    if (presentNatives.length === 0) return base;
    const desiredAgent = mergedNativeAgent(undefined, presentNatives);
    if (desiredAgent === undefined) {
      return { ...base, source: "conflict", state: "conflict", evidence: "native agent additions have incompatible common fields", conflictsWith: presentNatives.map((entry) => entry.path) };
    }
    return {
      ...base,
      desiredAgent,
      source: presentNatives.length === 1 ? presentNatives[0]!.target : "merged-native",
      sourcePath: presentNatives[0]!.path,
      state: "changed",
      canonicalOperation: "write",
      providerOperations: providerOperationsForAgent(base, desiredAgent, true),
    };
  }

  const changedSides = [sides.canonical, sides.claude, sides.codex].filter((side) => changed(side.delta));
  if (changedSides.length === 0) {
    if (canonical === undefined) return base;
    const disabledPresent = (["claude", "codex"] as const).filter((target) => canonical.targets[target] === false && sides[target].present);
    if (disabledPresent.length > 0) {
      return { ...base, source: "conflict", state: "conflict", evidence: "native output exists for a disabled agent target", conflictsWith: disabledPresent.map((target) => sides[target].path) };
    }
    const operations = providerOperationsForAgent(base, canonical, false);
    return {
      ...base,
      source: operations.length > 0 ? "canonical" : "none",
      state: operations.length > 0 ? "missing" : "synced",
      providerOperations: operations,
    };
  }

  if (changedSides.length === 1) {
    const side = changedSides[0]!;
    if (deleted(side.delta)) {
      return {
        ...base,
        source: "delete",
        state: "changed",
        canonicalOperation: sides.canonical.present ? "remove" : "none",
        providerOperations: (["claude", "codex"] as const)
          .filter((target) => sides[target].present)
          .map((target) => ({ target, operation: "remove", path: sides[target].path })),
      };
    }
    if (side.endpoint === "canonical" && canonical !== undefined) {
      return { ...base, source: "canonical", state: "changed", providerOperations: providerOperationsForAgent(base, canonical, true) };
    }
    if (side.endpoint === "claude" || side.endpoint === "codex") {
      if (canonical?.targets[side.endpoint] === false) {
        return { ...base, source: "conflict", state: "conflict", evidence: `native ${side.endpoint} output changed while its target is disabled`, conflictsWith: [side.path] };
      }
      const native = side.native;
      const desiredAgent = native === undefined ? undefined : mergedNativeAgent(canonical, [native]);
      if (desiredAgent !== undefined) {
        return {
          ...base,
          desiredAgent,
          source: side.endpoint,
          sourcePath: side.path,
          state: "changed",
          canonicalOperation: "write",
          providerOperations: providerOperationsForAgent(base, desiredAgent, true),
        };
      }
    }
  }

  if (changedSides.every((side) => deleted(side.delta))) {
    return {
      ...base,
      source: "delete",
      state: "changed",
      canonicalOperation: sides.canonical.present ? "remove" : "none",
      providerOperations: (["claude", "codex"] as const)
        .filter((target) => sides[target].present)
        .map((target) => ({ target, operation: "remove", path: sides[target].path })),
    };
  }
  if (canonical !== undefined
    && changed(sides.canonical.delta)
    && !deleted(sides.canonical.delta)) {
    const changedProviders = [sides.claude, sides.codex].filter((side) => changed(side.delta));
    if (changedProviders.every((side) => side.native !== undefined
      && nativeMatchesCanonical(side.native, canonical, side.endpoint as TargetName))) {
      return {
        ...base,
        source: "canonical",
        state: "changed",
        providerOperations: providerOperationsForAgent(base, canonical, true),
      };
    }
  }
  if (canonical !== undefined && expectedAgentMatchesAll(base, canonical)) {
    return {
      ...base,
      source: "canonical",
      state: "changed",
      providerOperations: providerOperationsForAgent(base, canonical, false),
      canRecordBaseline: providerOperationsForAgent(base, canonical, false).length === 0,
    };
  }
  if (sides.canonical.delta === "unchanged") {
    const changedNative = [sides.claude, sides.codex]
      .filter((side): side is EndpointSide & { native: NativeDefinition } => changed(side.delta) && side.native !== undefined)
      .map((side) => side.native);
    const desiredAgent = mergedNativeAgent(canonical, changedNative);
    if (desiredAgent !== undefined && changedNative.length > 0) {
      return {
        ...base,
        desiredAgent,
        source: "merged-native",
        sourcePath: changedNative[0]!.path,
        state: "changed",
        canonicalOperation: "write",
        providerOperations: providerOperationsForAgent(base, desiredAgent, true),
      };
    }
  }
  return {
    ...base,
    source: "conflict",
    state: "conflict",
    evidence: "agent endpoints changed incompatibly from their common baseline",
    conflictsWith: changedSides.map((side) => side.path),
  };
}

function outputState(plan: ReconciliationPlan, target: TargetName): DefinitionState {
  if (plan.state === "invalid") return "invalid";
  if (plan.state === "conflict" && plan.conflictsWith?.some((path) => samePath(path, plan.sides[target].path))) return "conflict";
  const operation = plan.providerOperations.find((entry) => entry.target === target);
  if (operation !== undefined) {
    return operation.operation === "write" && plan.sides[target].delta === "absent" ? "missing" : "changed";
  }
  return plan.state === "conflict" ? "synced" : plan.state;
}

export function recordForPlan(scope: Scope, plan: ReconciliationPlan): DefinitionRecord {
  const canonical = plan.sides.canonical.present ? plan.canonicalPath : null;
  const outputs: DefinitionOutput[] = plan.kind === "skill"
    ? [
        { target: "codex", path: plan.canonicalPath, state: plan.sides.canonical.valid ? plan.state : "invalid", readsCanonicalDirectly: true },
        { target: "claude", path: plan.sides.claude.path, state: outputState(plan, "claude") },
      ]
    : (["claude", "codex"] as const).flatMap((target) => {
        const agent = plan.canonical as CanonicalAgent | undefined;
        if (agent?.targets[target] === false && !plan.sides[target].present) return [];
        return [{ target, path: plan.sides[target].path, state: outputState(plan, target) }];
      });
  const record: DefinitionRecord = {
    kind: plan.kind,
    name: plan.name,
    scope: scope.type,
    scopePath: scope.path,
    state: plan.state,
    canonical,
    outputs,
  };
  if (plan.evidence !== undefined) record.evidence = plan.evidence;
  if (plan.conflictsWith !== undefined) record.conflictsWith = plan.conflictsWith;
  return record;
}

export async function buildReconciliationPlans(input: PlannerInput): Promise<ReconciliationPlan[]> {
  const canonical = new Map<string, CanonicalSkill | CanonicalAgent>();
  for (const skill of input.canonical.skills) canonical.set(definitionKey("skill", skill.name), skill);
  for (const agent of input.canonical.agents) canonical.set(definitionKey("agent", agent.name), agent);
  const keys = new Set(canonical.keys());
  for (const entry of input.native) keys.add(definitionKey(entry.kind, entry.name));
  for (const kind of ["skill", "agent"] as const) {
    for (const name of Object.keys(input.ledger.entries[kind])) keys.add(definitionKey(kind, name));
  }

  const plans: ReconciliationPlan[] = [];
  for (const rawKey of [...keys].sort(compareText)) {
    const separator = rawKey.indexOf(":");
    const kind = rawKey.slice(0, separator) as ArtifactKind;
    const name = rawKey.slice(separator + 1);
    const definition = canonical.get(rawKey);
    const baseline = getLedgerEntry(input.ledger, {
      scopeIdentity: input.ledger.scopeIdentity,
      kind,
      name,
    });
    if (kind === "skill") {
      plans.push(await buildSkillPlan(input, name, definition as CanonicalSkill | undefined, baseline));
    } else {
      plans.push(await buildAgentPlan(input, name, definition as CanonicalAgent | undefined, baseline));
    }
  }
  return plans;
}
