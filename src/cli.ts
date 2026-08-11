#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { initialize, inspect, synchronize } from "./engine.js";
import type {
  ActionRecord,
  CliIo,
  DefinitionRecord,
  EngineOptions,
  OutputDocument,
  OutputError,
} from "./types.js";

type Command = OutputDocument["command"];

interface ParsedArguments {
  command: Command;
  json: boolean;
}

interface RuntimeOverrides {
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

type ArgumentOutcome =
  | { kind: "run"; arguments: ParsedArguments }
  | { kind: "help"; command?: Command }
  | { kind: "version" };

const commands = new Set<Command>(["init", "status", "check", "sync"]);
const packageVersion = readPackageVersion();

class UsageError extends Error {
  readonly code = "usage" as const;
}

function readPackageVersion(): string {
  try {
    const source = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(source) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function usage(command?: Command): string {
  if (command !== undefined) return `Usage: overlord ${command} [--json]\n`;
  return `Usage: overlord <command> [--json]\n
Commands:
  init      Create the user source and discovery configuration
  status    Discover every scope and report its state
  check     Exit non-zero when any discovered scope needs attention
  sync      Discover and synchronize every safe definition

Options:
  --json     Emit one machine-readable JSON document
  --help     Show help
  --version  Show the installed version
`;
}

function parseArguments(argv: readonly string[]): ArgumentOutcome {
  let command: Command | undefined;
  let json = false;
  let help = false;
  let version = false;

  for (const token of argv) {
    if (commands.has(token as Command)) {
      if (command !== undefined) throw new UsageError(`Only one command may be supplied; found '${token}'`);
      command = token as Command;
    } else if (token === "--json") {
      json = true;
    } else if (token === "--help") {
      help = true;
    } else if (token === "--version") {
      version = true;
    } else if (token.startsWith("-")) {
      throw new UsageError(`Unknown option '${token}'`);
    } else {
      throw new UsageError(`Unknown command or argument '${token}'`);
    }
  }

  if (json && (help || version)) throw new UsageError("--json cannot be combined with --help or --version");
  if (help) return command === undefined ? { kind: "help" } : { kind: "help", command };
  if (version) return { kind: "version" };
  if (command === undefined) throw new UsageError("A command is required");
  return { kind: "run", arguments: { command, json } };
}

function fallbackCommand(argv: readonly string[]): Command {
  const value = argv.find((token) => !token.startsWith("-"));
  return commands.has(value as Command) ? value as Command : "status";
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

function engineOptions(overrides: RuntimeOverrides | undefined): EngineOptions {
  return {
    home: overrides?.home ?? homedir(),
    env: overrides?.env ?? process.env,
  };
}

function normalizeDocument(document: OutputDocument, command: Command): OutputDocument {
  return { ...document, schemaVersion: 2, command, overlordVersion: packageVersion };
}

function errorDetails(error: unknown): OutputError {
  const record = error !== null && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const knownCodes = new Set<OutputError["code"]>([
    "usage",
    "config-invalid",
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

function completedErrorActions(error: unknown): ActionRecord[] {
  if (error === null || typeof error !== "object") return [];
  const raw = (error as { completedActions?: unknown }).completedActions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is ActionRecord => {
    if (entry === null || typeof entry !== "object") return false;
    const action = entry as Partial<ActionRecord>;
    return typeof action.id === "string"
      && typeof action.description === "string"
      && action.status === "completed"
      && (action.scope === "user" || action.scope === "project")
      && typeof action.scopePath === "string";
  });
}

function errorDocument(command: Command, error: unknown): OutputDocument {
  const actions = completedErrorActions(error);
  const document: OutputDocument = {
    schemaVersion: 2,
    overlordVersion: packageVersion,
    command,
    status: "error",
    error: errorDetails(error),
  };
  if (actions.length > 0) document.actions = actions;
  return document;
}

function exitCode(document: OutputDocument): number {
  if (document.status === "error") return document.error?.code === "internal" ? 3 : 2;
  if (document.command === "status" || document.command === "init") return 0;
  return document.status === "attention-required" ? 1 : 0;
}

function writeJson(io: CliIo, document: OutputDocument): void {
  io.stdout(`${JSON.stringify(document)}\n`);
}

function definitionLine(definition: DefinitionRecord): string {
  const marker: Record<DefinitionRecord["state"], string> = {
    synced: "ok",
    missing: "missing",
    changed: "changed",
    conflict: "conflict",
    invalid: "invalid",
  };
  return `  ${marker[definition.state].padEnd(9)} ${definition.kind}:${definition.name}`;
}

function writeAction(
  write: (chunk: string) => void,
  action: ActionRecord,
  marker: string,
): void {
  write(`${marker} ${action.description}\n`);
  if (action.commit === undefined) return;
  write(`  commit: ${action.commit.sha} ${action.commit.message}\n`);
  for (const origin of action.commit.origins) write(`  origin: ${origin}\n`);
  for (const file of action.commit.files) write(`  file: ${file}\n`);
}

function writeHuman(io: CliIo, document: OutputDocument): void {
  if (document.status === "error") {
    io.stderr(`overlord: ${document.error?.message ?? "Unknown error"}\n`);
    for (const action of document.actions ?? []) writeAction(io.stderr, action, "completed:");
    if (document.error?.code === "usage") io.stderr("Try 'overlord --help' for usage.\n");
    return;
  }

  io.stdout(`${document.command}: ${document.status}\n`);
  for (const scope of document.scopes ?? []) {
    io.stdout(`Scope: ${scope.path} (${scope.type})\n`);
    const definitions = document.definitions?.filter((entry) => entry.scopePath === scope.path) ?? [];
    for (const definition of definitions) io.stdout(`${definitionLine(definition)}\n`);
  }
  for (const action of document.actions ?? []) {
    writeAction(io.stdout, action, action.status === "completed" ? "+" : "?");
  }
  for (const entry of document.diagnostics ?? []) {
    const destination = entry.severity === "info" ? io.stdout : io.stderr;
    const scope = entry.scopePath === undefined ? "" : ` [${entry.scopePath}]`;
    destination(`${entry.severity}${scope}: ${entry.message}\n`);
  }
}

async function execute(parsed: ParsedArguments, overrides?: RuntimeOverrides): Promise<OutputDocument> {
  const options = engineOptions(overrides);
  if (parsed.command === "init") return normalizeDocument(await initialize(options), "init");
  if (parsed.command === "sync") return normalizeDocument(await synchronize(options), "sync");
  return normalizeDocument(await inspect(options), parsed.command);
}

/** Run one CLI invocation without terminating the host process. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
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
    const document = await execute(outcome.arguments, runtimeOverrides);
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
  const io: CliIo = {
    stdout(chunk) { process.stdout.write(chunk); },
    stderr(chunk) { process.stderr.write(chunk); },
  };
  void runCli(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
}
