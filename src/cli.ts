#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { initialize, inspect, synchronize } from "./engine.js";
import type {
  ActionRecord,
  CliIo,
  DefinitionRecord,
  EngineOptions,
  OutputDocument,
  OutputError,
  ResolutionSide,
} from "./types.js";

type Command = OutputDocument["command"];

interface PromptingCliIo extends CliIo {
  /** Optional hook used by embedders and tests to support interactive sync. */
  prompt?(question: string): string | Promise<string>;
}

interface ParsedArguments {
  command: Command;
  json: boolean;
  dryRun: boolean;
  strict: boolean;
  global: boolean;
  project?: string;
  resolutions: Record<string, ResolutionSide>;
}

interface ParseOutcome {
  kind: "run";
  arguments: ParsedArguments;
}

interface InformationalOutcome {
  kind: "help" | "version";
  command?: Command;
}

type ArgumentOutcome = ParseOutcome | InformationalOutcome;
type RuntimeOverrides = Partial<Pick<EngineOptions, "cwd" | "home" | "env" | "availability">>;

const commands = new Set<Command>(["init", "status", "check", "sync"]);
const resolutionSides = new Set<ResolutionSide>([
  "agents",
  "claude",
  "codex",
  "adopt",
  "external",
  "delete",
  "skip",
]);

const packageVersion = readPackageVersion();

class UsageError extends Error {
  readonly code = "usage" as const;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function readPackageVersion(): string {
  try {
    const value = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function usage(command?: Command): string {
  const common = "[--global | --project <path>] [--json]";
  if (command === "init") return `Usage: overlord init ${common} [--dry-run]\n`;
  if (command === "status" || command === "check") {
    return `Usage: overlord ${command} ${common} [--strict]\n`;
  }
  if (command === "sync") {
    return `Usage: overlord sync ${common} [--strict] [--dry-run] [--resolve <selector>=<side>]...\n`;
  }
  return [
    "Usage: overlord <command> [options]",
    "",
    "Commands:",
    "  init      Create the canonical directory and configuration",
    "  status    Inspect the selected scope",
    "  check     Assert that the selected scope is synchronized",
    "  sync      Reconcile canonical and provider-native definitions",
    "",
    "Common options:",
    "  --global              Select the user scope",
    "  --project <path>      Select a project scope",
    "  --json                Emit one machine-readable JSON document",
    "  --help                Show help",
    "  --version             Show the installed version",
    "",
    "Sync options:",
    "  --dry-run             Plan changes without writing",
    "  --resolve <key>=<side>  Resolve one outstanding decision (repeatable)",
    "",
  ].join("\n");
}

function valueAfter(argv: readonly string[], index: number, flag: string): { value: string; next: number } {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} requires a value`);
  return { value, next: index + 1 };
}

function inlineValue(token: string, flag: string): string | undefined {
  const prefix = `${flag}=`;
  if (!token.startsWith(prefix)) return undefined;
  const value = token.slice(prefix.length);
  if (value.length === 0) throw new UsageError(`${flag} requires a value`);
  return value;
}

function parseResolution(value: string, resolutions: Record<string, ResolutionSide>): void {
  const separator = value.lastIndexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new UsageError("--resolve must be <selector>=<side>");
  }
  const selector = value.slice(0, separator);
  const side = value.slice(separator + 1);
  if (!resolutionSides.has(side as ResolutionSide)) {
    throw new UsageError(`Unknown resolution side '${side}'`);
  }
  if (Object.hasOwn(resolutions, selector)) {
    throw new UsageError(`Resolution selector '${selector}' was supplied more than once`);
  }
  resolutions[selector] = side as ResolutionSide;
}

function parseArguments(argv: readonly string[]): ArgumentOutcome {
  let command: Command | undefined;
  let json = false;
  let dryRun = false;
  let strict = false;
  let global = false;
  let project: string | undefined;
  let help = false;
  let version = false;
  const resolutions = Object.create(null) as Record<string, ResolutionSide>;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (!token.startsWith("-")) {
      if (!commands.has(token as Command)) {
        throw new UsageError(command === undefined ? `Unknown command '${token}'` : `Unexpected argument '${token}'`);
      }
      if (command !== undefined) throw new UsageError(`Unexpected command '${token}' after '${command}'`);
      command = token as Command;
      continue;
    }

    if (token === "--json") json = true;
    else if (token === "--dry-run") dryRun = true;
    else if (token === "--strict") strict = true;
    else if (token === "--global") global = true;
    else if (token === "--help" || token === "-h") help = true;
    else if (token === "--version" || token === "-V") version = true;
    else if (token === "--project") {
      const parsed = valueAfter(argv, index, "--project");
      project = parsed.value;
      index = parsed.next;
    } else if (token.startsWith("--project=")) {
      project = inlineValue(token, "--project");
    } else if (token === "--resolve") {
      const parsed = valueAfter(argv, index, "--resolve");
      parseResolution(parsed.value, resolutions);
      index = parsed.next;
    } else if (token.startsWith("--resolve=")) {
      const value = inlineValue(token, "--resolve");
      if (value === undefined) throw new UsageError("--resolve requires a value");
      parseResolution(value, resolutions);
    } else {
      throw new UsageError(`Unknown option '${token}'`);
    }
  }

  if (json && (help || version)) throw new UsageError("--json cannot be combined with --help or --version");
  if (help) return command === undefined ? { kind: "help" } : { kind: "help", command };
  if (version) return { kind: "version" };
  if (command === undefined) throw new UsageError("A command is required");
  if (global && project !== undefined) throw new UsageError("--global and --project cannot be used together");
  if (dryRun && command !== "init" && command !== "sync") {
    throw new UsageError(`--dry-run is not supported by '${command}'`);
  }
  if (strict && command === "init") throw new UsageError("--strict is not supported by 'init'");
  if (Object.keys(resolutions).length > 0 && command !== "sync") {
    throw new UsageError("--resolve is only supported by 'sync'");
  }

  const parsed: ParsedArguments = { command, json, dryRun, strict, global, resolutions };
  if (project !== undefined) parsed.project = project;
  return { kind: "run", arguments: parsed };
}

function fallbackCommand(argv: readonly string[]): Command {
  let consumesValue = false;
  for (const token of argv) {
    if (consumesValue) {
      consumesValue = false;
      continue;
    }
    if (token === "--project" || token === "--resolve") {
      consumesValue = true;
      continue;
    }
    if (token.startsWith("-")) continue;
    return commands.has(token as Command) ? token as Command : "status";
  }
  return "status";
}

function wantsJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

function assertSupportedRuntime(): void {
  const major = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 22) {
    throw new UsageError(`Node.js 22 or newer is required (running ${process.versions.node})`);
  }
}

function engineOptions(parsed: ParsedArguments, overrides: RuntimeOverrides | undefined): EngineOptions {
  const options: EngineOptions = {
    cwd: overrides?.cwd ?? process.cwd(),
    home: overrides?.home ?? homedir(),
    env: overrides?.env ?? process.env,
  };
  if (overrides?.availability !== undefined) options.availability = overrides.availability;
  if (parsed.global) options.global = true;
  if (parsed.project !== undefined) options.project = parsed.project;
  if (parsed.strict) options.strict = true;
  return options;
}

function normalizeDocument(document: OutputDocument, command: Command, dryRun: boolean): OutputDocument {
  const normalized: OutputDocument = { ...document, schemaVersion: 1, command, overlordVersion: packageVersion };
  if (dryRun) normalized.dryRun = true;
  return normalized;
}

function errorDetails(error: unknown): OutputError {
  const record = error !== null && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const knownCodes = new Set<OutputError["code"]>([
    "usage",
    "config-invalid",
    "scope-unresolvable",
    "lock-held",
    "permission-denied",
    "internal",
  ]);
  const rawCode = record?.code;
  let code: OutputError["code"];
  if (typeof rawCode === "string" && knownCodes.has(rawCode as OutputError["code"])) {
    code = rawCode as OutputError["code"];
  } else if (rawCode === "EACCES" || rawCode === "EPERM" || rawCode === "EROFS") {
    code = "permission-denied";
  } else {
    code = "internal";
  }

  const message = error instanceof Error ? error.message : String(error);
  const result: OutputError = { code, message: message || "Unknown error" };
  if (typeof record?.path === "string") result.path = record.path;
  if (typeof record?.detail === "string") result.detail = record.detail;
  return result;
}

function errorDocument(command: Command, error: unknown): OutputDocument {
  const document: OutputDocument = {
    schemaVersion: 1,
    overlordVersion: packageVersion,
    command,
    status: "error",
    error: errorDetails(error),
  };
  if (error !== null && typeof error === "object") {
    const raw = (error as { completedActions?: unknown }).completedActions;
    if (Array.isArray(raw)) {
      const actions = raw.filter((entry): entry is ActionRecord => {
        if (entry === null || typeof entry !== "object") return false;
        const action = entry as Partial<ActionRecord>;
        return typeof action.id === "string"
          && typeof action.description === "string"
          && typeof action.mutates === "boolean"
          && Array.isArray(action.argv)
          && action.argv.every((argument) => typeof argument === "string");
      });
      if (actions.length > 0) document.actions = actions;
    }
  }
  return document;
}

function exitCode(document: OutputDocument): number {
  if (document.status === "error") return document.error?.code === "internal" ? 3 : 2;
  if (document.command === "status") return 0;
  return document.status === "attention-required" ? 1 : 0;
}

function writeJson(io: CliIo, document: OutputDocument): void {
  io.stdout(`${JSON.stringify(document)}\n`);
}

function definitionLine(definition: DefinitionRecord): string {
  const marker: Record<DefinitionRecord["state"], string> = {
    synced: "ok",
    external: "external",
    missing: "missing",
    unadopted: "unadopted",
    conflict: "conflict",
    invalid: "invalid",
  };
  return `  ${marker[definition.state].padEnd(9)} ${definition.kind}:${definition.name}`;
}

function writeHuman(io: CliIo, document: OutputDocument): void {
  if (document.status === "error") {
    io.stderr(`overlord: ${document.error?.message ?? "Unknown error"}\n`);
    for (const action of document.actions ?? []) {
      io.stderr(`completed: ${action.description}\n`);
      for (const backup of action.backups ?? []) io.stderr(`  backup: ${backup}\n`);
    }
    if (document.error?.code === "usage") io.stderr("Try 'overlord --help' for usage.\n");
    return;
  }

  io.stdout(`${document.command}: ${document.status}\n`);
  if (document.scope !== undefined) io.stdout(`Scope: ${document.scope.path} (${document.scope.type})\n`);
  for (const target of document.targets ?? []) {
    io.stdout(`Target ${target.name}: ${target.available ? target.version ?? "available" : "unavailable"}\n`);
  }
  if ((document.definitions?.length ?? 0) > 0) {
    io.stdout("Definitions:\n");
    for (const definition of document.definitions ?? []) io.stdout(`${definitionLine(definition)}\n`);
  }
  for (const action of document.actions ?? []) io.stdout(`${action.mutates ? "+" : "-"} ${action.description}\n`);
  for (const diagnostic of document.diagnostics ?? []) {
    const destination = diagnostic.severity === "info" ? io.stdout : io.stderr;
    destination(`${diagnostic.severity}: ${diagnostic.message}\n`);
  }
}

function shortcut(answer: string, options: readonly ResolutionSide[]): ResolutionSide | undefined {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "") return "skip";
  if (resolutionSides.has(normalized as ResolutionSide) && options.includes(normalized as ResolutionSide)) {
    return normalized as ResolutionSide;
  }
  const aliases: Readonly<Record<string, readonly ResolutionSide[]>> = {
    a: ["agents", "adopt"],
    c: ["claude"],
    o: ["codex"],
    y: ["adopt"],
    e: ["external"],
    x: ["delete"],
    s: ["skip"],
  };
  const matches = (aliases[normalized] ?? []).filter((side) => options.includes(side));
  return matches.length === 1 ? matches[0] : undefined;
}

function selectorForms(definition: DefinitionRecord): Set<string> {
  const decision = definition.decision;
  if (decision === undefined) return new Set();
  const forms = new Set<string>([
    definition.name,
    `${definition.kind}:${definition.name}`,
    decision.selector,
  ]);
  const prefix = `${definition.kind}:${definition.name}@`;
  if (decision.selector.startsWith(prefix)) {
    const scope = decision.selector.slice(prefix.length);
    forms.add(`${definition.name}@${scope}`);
  }
  const scopeAlias = definition.scope === "user" ? "user" : "project";
  forms.add(`${definition.name}@${scopeAlias}`);
  forms.add(`${definition.kind}:${definition.name}@${scopeAlias}`);
  return forms;
}

function matchingDecisions(document: OutputDocument, selector: string): DefinitionRecord[] {
  return (document.definitions ?? []).filter((definition) =>
    definition.decision !== undefined && selectorForms(definition).has(selector),
  );
}

interface DiffLine {
  marker: " " | "+" | "-";
  text: string;
}

function lineDiff(left: string, right: string): DiffLine[] {
  const leftLines = left.replace(/\r\n?/g, "\n").split("\n");
  const rightLines = right.replace(/\r\n?/g, "\n").split("\n");
  // Skills and agent definitions are intentionally small. Keep an explicit
  // guard so a mistakenly huge artifact cannot create an enormous LCS table.
  if (leftLines.length * rightLines.length > 250_000) {
    return [
      ...leftLines.map((text): DiffLine => ({ marker: "-", text })),
      ...rightLines.map((text): DiffLine => ({ marker: "+", text })),
    ];
  }
  const lengths = Array.from(
    { length: leftLines.length + 1 },
    () => new Uint32Array(rightLines.length + 1),
  );
  for (let leftIndex = leftLines.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = rightLines.length - 1; rightIndex >= 0; rightIndex -= 1) {
      lengths[leftIndex]![rightIndex] = leftLines[leftIndex] === rightLines[rightIndex]
        ? lengths[leftIndex + 1]![rightIndex + 1]! + 1
        : Math.max(lengths[leftIndex + 1]![rightIndex]!, lengths[leftIndex]![rightIndex + 1]!);
    }
  }
  const result: DiffLine[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftLines.length || rightIndex < rightLines.length) {
    if (leftIndex < leftLines.length && rightIndex < rightLines.length && leftLines[leftIndex] === rightLines[rightIndex]) {
      result.push({ marker: " ", text: leftLines[leftIndex]! });
      leftIndex += 1;
      rightIndex += 1;
    } else if (rightIndex >= rightLines.length || (
      leftIndex < leftLines.length
      && lengths[leftIndex + 1]![rightIndex]! >= lengths[leftIndex]![rightIndex + 1]!
    )) {
      result.push({ marker: "-", text: leftLines[leftIndex]! });
      leftIndex += 1;
    } else {
      result.push({ marker: "+", text: rightLines[rightIndex]! });
      rightIndex += 1;
    }
  }
  return result;
}

function artifactTextPath(definition: DefinitionRecord, path: string): string {
  return definition.kind === "skill" ? join(path, "SKILL.md") : path;
}

async function writeDecisionDiff(definition: DefinitionRecord, io: CliIo, full: boolean): Promise<void> {
  if (definition.canonical == null) return;
  const canonicalPath = artifactTextPath(definition, definition.canonical);
  for (const nativeOutput of definition.outputs ?? []) {
    if (nativeOutput.state !== "conflict" || nativeOutput.readsCanonicalDirectly === true) continue;
    const nativePath = artifactTextPath(definition, nativeOutput.path);
    try {
      const [canonical, native] = await Promise.all([
        readFile(canonicalPath, "utf8"),
        readFile(nativePath, "utf8"),
      ]);
      const lines = lineDiff(canonical, native);
      const visible = full ? lines : lines.filter((line) => line.marker !== " ");
      io.stdout(`  diff ${canonicalPath} -> ${nativePath}${full ? " (full)" : ""}:\n`);
      for (const line of visible.slice(0, full ? visible.length : 12)) {
        io.stdout(`    ${line.marker} ${line.text}\n`);
      }
      if (!full && visible.length > 12) io.stdout(`    ... ${visible.length - 12} more changed lines (enter d for full diff)\n`);
    } catch (error) {
      io.stdout(`  diff unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

async function describeDecision(document: OutputDocument, definition: DefinitionRecord, io: CliIo): Promise<void> {
  io.stdout(`\nDecision: ${definition.kind}:${definition.name} is ${definition.state}\n`);
  if (definition.evidence !== undefined) io.stdout(`  ${definition.evidence}\n`);
  if (definition.canonical !== undefined && definition.canonical !== null) {
    io.stdout(`  canonical: ${definition.canonical}\n`);
  }
  for (const output of definition.outputs ?? []) io.stdout(`  ${output.target}: ${output.path} (${output.state})\n`);
  await writeDecisionDiff(definition, io, false);

  const selector = definition.decision?.selector;
  if (selector === undefined) return;
  for (const action of document.actions ?? []) {
    if (action.requiresDecision !== true || !action.argv.some((argument) => argument.includes(selector))) continue;
    io.stdout(`  action: ${action.description}\n`);
    for (const path of action.reads ?? []) io.stdout(`    read: ${path}\n`);
    for (const path of action.writes ?? []) io.stdout(`    write: ${path}\n`);
    for (const path of action.removes ?? []) io.stdout(`    remove: ${path}\n`);
  }
}

async function collectInteractiveResolutions(
  document: OutputDocument,
  io: PromptingCliIo,
  supplied: Readonly<Record<string, ResolutionSide>>,
): Promise<{ resolutions: Record<string, ResolutionSide>; confirmedDelete: boolean }> {
  const resolutions = Object.create(null) as Record<string, ResolutionSide>;
  let confirmedDelete = false;
  if (!io.isTTY || io.prompt === undefined) return { resolutions, confirmedDelete };

  for (const definition of document.definitions ?? []) {
    const decision = definition.decision;
    if (decision === undefined) continue;
    if (Object.keys(supplied).some((selector) => selectorForms(definition).has(selector))) continue;
    await describeDecision(document, definition, io);
    let selected: ResolutionSide | undefined;
    while (selected === undefined) {
      const answer = await io.prompt(`${definition.kind}:${definition.name} [${decision.options.join("/")}] (skip): `);
      if (answer.trim().toLowerCase() === "d") {
        await writeDecisionDiff(definition, io, true);
        continue;
      }
      selected = shortcut(answer, decision.options);
      if (selected === undefined) io.stderr(`Choose one of: ${decision.options.join(", ")}\n`);
    }
    if (selected === "delete") {
      const answer = (await io.prompt(`Delete ${definition.kind}:${definition.name} after creating a backup? [y/N] `)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") selected = "skip";
      else confirmedDelete = true;
    }
    resolutions[decision.selector] = selected;
  }
  return { resolutions, confirmedDelete };
}

async function normalizeResolutions(
  options: EngineOptions,
  supplied: Readonly<Record<string, ResolutionSide>>,
): Promise<Record<string, ResolutionSide>> {
  const resolutions = Object.create(null) as Record<string, ResolutionSide>;
  const entries = Object.entries(supplied);
  if (entries.length === 0) return resolutions;
  const inventory = await inspect(options);
  for (const [selector, side] of entries) {
    const matches = matchingDecisions(inventory, selector);
    if (matches.length === 0) throw new UsageError(`Resolution selector '${selector}' has no outstanding decision`);
    if (matches.length > 1) {
      const qualified = matches.flatMap((definition) => definition.decision?.selector ?? []);
      throw new UsageError(`Resolution selector '${selector}' is ambiguous; use one of: ${qualified.join(", ")}`);
    }
    const match = matches[0];
    if (match?.decision?.options.includes(side) !== true) {
      throw new UsageError(`Resolution side '${side}' is not valid for '${selector}'`);
    }
    const qualified = match.decision.selector;
    if (Object.hasOwn(resolutions, qualified)) {
      throw new UsageError(`The decision '${qualified}' was resolved more than once`);
    }
    resolutions[qualified] = side;
  }
  return resolutions;
}

async function confirmExplicitDeletes(
  resolutions: Record<string, ResolutionSide>,
  parsed: ParsedArguments,
  io: PromptingCliIo,
): Promise<boolean> {
  const entries = Object.entries(resolutions).filter(([, side]) => side === "delete");
  if (entries.length === 0 || parsed.dryRun || parsed.json || !io.isTTY) return entries.length > 0;
  if (io.prompt === undefined) {
    for (const [selector] of entries) resolutions[selector] = "skip";
    return false;
  }
  let confirmed = false;
  for (const [selector] of entries) {
    const answer = (await io.prompt(`Delete ${selector} after creating a backup? [y/N] `)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") confirmed = true;
    else resolutions[selector] = "skip";
  }
  return confirmed;
}

async function execute(parsed: ParsedArguments, io: PromptingCliIo, overrides?: RuntimeOverrides): Promise<OutputDocument> {
  const options = engineOptions(parsed, overrides);
  if (parsed.command === "status" || parsed.command === "check") {
    return normalizeDocument(await inspect(options), parsed.command, false);
  }
  if (parsed.command === "init") {
    return normalizeDocument(await initialize(options, { dryRun: parsed.dryRun }), parsed.command, parsed.dryRun);
  }

  const resolutions = await normalizeResolutions(options, parsed.resolutions);
  let confirmDestructive = await confirmExplicitDeletes(resolutions, parsed, io);
  let document = normalizeDocument(
    await synchronize(options, { dryRun: parsed.dryRun, resolutions, confirmDestructive }),
    "sync",
    parsed.dryRun,
  );

  if (!parsed.json && !parsed.dryRun) {
    const interactive = await collectInteractiveResolutions(document, io, parsed.resolutions);
    if (Object.keys(interactive.resolutions).length > 0) {
      Object.assign(resolutions, interactive.resolutions);
      confirmDestructive ||= interactive.confirmedDelete;
      document = normalizeDocument(
        await synchronize(options, { dryRun: false, resolutions, confirmDestructive }),
        "sync",
        false,
      );
    }
  }
  return document;
}

/**
 * Run one CLI invocation without terminating the host process.
 *
 * The injectable I/O and runtime values keep the public command deterministic
 * for tests and programmatic callers.
 */
export async function runCli(
  argv: readonly string[],
  io: PromptingCliIo,
  runtimeOverrides?: RuntimeOverrides,
): Promise<number> {
  const json = wantsJson(argv);
  const command = fallbackCommand(argv);
  try {
    assertSupportedRuntime();
    const outcome = parseArguments(argv);
    if (outcome.kind !== "run") {
      if (outcome.kind === "help") io.stdout(usage(outcome.command));
      else io.stdout(`${packageVersion}\n`);
      return 0;
    }
    const document = await execute(outcome.arguments, io, runtimeOverrides);
    if (outcome.arguments.json) writeJson(io, document);
    else writeHuman(io, document);
    return exitCode(document);
  } catch (error) {
    const document = errorDocument(command, error);
    if (json) writeJson(io, document);
    else writeHuman(io, document);
    return exitCode(document);
  }
}

function directlyInvoked(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (directlyInvoked()) {
  const io: PromptingCliIo = {
    stdout(chunk) { process.stdout.write(chunk); },
    stderr(chunk) { process.stderr.write(chunk); },
    isTTY: process.stdin.isTTY === true,
    async prompt(question) {
      const readline = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await readline.question(question);
      } finally {
        readline.close();
      }
    },
  };
  void runCli(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
}
