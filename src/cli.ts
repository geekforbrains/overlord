#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { initialize, inspect, synchronize } from "./engine.js";
import {
  inspectService,
  installService,
  planService,
  readServiceLogs,
  uninstallService,
  type ServiceCommand,
  type ServiceOptions,
  type ServicePlan,
  type ServiceStatus,
} from "./service.js";
import { watchFleet, type WatchFleetOptions, type WatchReport } from "./watch.js";
import { acquireWatchLifetimeLock } from "./watch-lock.js";
import type {
  ActionRecord,
  CliIo,
  DefinitionRecord,
  EngineOptions,
  OutputDocument,
  OutputError,
} from "./types.js";

type OneShotCommand = OutputDocument["command"];
type ServiceAction = "install" | "status" | "logs" | "uninstall";
type CliCommand = OneShotCommand | "watch" | "service";

interface ParsedArguments {
  command: CliCommand;
  json: boolean;
  dryRun: boolean;
  serviceAction?: ServiceAction;
}

interface RuntimeOverrides {
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  watch?: Omit<WatchFleetOptions, "engine" | "signal" | "onReport">;
  service?: Omit<ServiceOptions, "home" | "env" | "version">;
}

type ArgumentOutcome =
  | { kind: "run"; arguments: ParsedArguments }
  | { kind: "help"; command?: CliCommand; serviceAction?: ServiceAction }
  | { kind: "version" };

const oneShotCommands = new Set<OneShotCommand>(["init", "status", "check", "sync"]);
const commands = new Set<CliCommand>([...oneShotCommands, "watch", "service"]);
const serviceActions = new Set<ServiceAction>(["install", "status", "logs", "uninstall"]);
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

function usage(command?: CliCommand, serviceAction?: ServiceAction): string {
  if (command === "watch") return "Usage: overlord watch\n";
  if (command === "service") {
    if (serviceAction === "install") return "Usage: overlord service install [--dry-run]\n";
    if (serviceAction !== undefined) return `Usage: overlord service ${serviceAction}\n`;
    return `Usage: overlord service <command> [options]\n
Commands:
  install    Install, enable, and start the user auto-sync service
  status     Inspect the installed service and pinned runtime
  logs       Print a bounded recent service log
  uninstall  Stop, disable, and remove the service definition

Options:
  --dry-run  Preview service installation without mutation
  --help     Show help
`;
  }
  if (command !== undefined) return `Usage: overlord ${command} [--json]\n`;
  return `Usage: overlord <command> [options]\n
Commands:
  init      Create the user source and discovery configuration
  status    Discover every scope and report its state
  check     Exit non-zero when any discovered scope needs attention
  sync      Discover and synchronize every safe definition
  watch     Keep the fleet synchronized until interrupted
  service   Install and manage the user auto-sync service

Options:
  --json     Emit one machine-readable JSON document (one-shot fleet commands only)
  --help     Show help
  --version  Show the installed version
`;
}

function parseArguments(argv: readonly string[]): ArgumentOutcome {
  const positional: string[] = [];
  let json = false;
  let dryRun = false;
  let help = false;
  let version = false;

  for (const token of argv) {
    if (token === "--json") {
      json = true;
    } else if (token === "--dry-run") {
      dryRun = true;
    } else if (token === "--help") {
      help = true;
    } else if (token === "--version") {
      version = true;
    } else if (token.startsWith("-")) {
      throw new UsageError(`Unknown option '${token}'`);
    } else {
      positional.push(token);
    }
  }

  if (json && (help || version)) throw new UsageError("--json cannot be combined with --help or --version");
  const commandToken = positional[0];
  const command = commands.has(commandToken as CliCommand) ? commandToken as CliCommand : undefined;
  if (commandToken !== undefined && command === undefined) throw new UsageError(`Unknown command or argument '${commandToken}'`);

  let serviceAction: ServiceAction | undefined;
  if (command === "service") {
    const actionToken = positional[1];
    if (serviceActions.has(actionToken as ServiceAction)) serviceAction = actionToken as ServiceAction;
    else if (actionToken !== undefined) throw new UsageError(`Unknown service command '${actionToken}'`);
    if (positional.length > 2) throw new UsageError(`Unknown command or argument '${positional[2]}'`);
  } else if (positional.length > 1) {
    if (commands.has(positional[1] as CliCommand)) {
      throw new UsageError(`Only one command may be supplied; found '${positional[1]}'`);
    }
    throw new UsageError(`Unknown command or argument '${positional[1]}'`);
  }

  if (help) {
    if (command === undefined) return { kind: "help" };
    return serviceAction === undefined ? { kind: "help", command } : { kind: "help", command, serviceAction };
  }
  if (version) return { kind: "version" };
  if (command === undefined) throw new UsageError("A command is required");
  if (command === "watch" && json) throw new UsageError("--json is not supported by watch");
  if (command === "service" && serviceAction === undefined) throw new UsageError("A service command is required");
  if (command === "service" && json) throw new UsageError("--json is not supported by service commands");
  if (dryRun && (command !== "service" || serviceAction !== "install")) {
    throw new UsageError("--dry-run is supported only by 'service install'");
  }
  return {
    kind: "run",
    arguments: {
      command,
      json,
      dryRun,
      ...(serviceAction === undefined ? {} : { serviceAction }),
    },
  };
}

function fallbackCommand(argv: readonly string[]): OneShotCommand {
  const value = argv.find((token) => !token.startsWith("-"));
  return oneShotCommands.has(value as OneShotCommand) ? value as OneShotCommand : "status";
}

function wantsJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

function serviceOptions(overrides: RuntimeOverrides | undefined): ServiceOptions {
  const uid = overrides?.service?.uid ?? process.getuid?.();
  return {
    ...overrides?.service,
    home: overrides?.home ?? homedir(),
    env: overrides?.env ?? process.env,
    platform: overrides?.service?.platform ?? process.platform,
    ...(uid === undefined ? {} : { uid }),
    nodePath: overrides?.service?.nodePath ?? process.execPath,
    cliPath: overrides?.service?.cliPath ?? fileURLToPath(import.meta.url),
    version: packageVersion,
  };
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

function normalizeDocument(document: OutputDocument, command: OneShotCommand): OutputDocument {
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

function errorDocument(command: OneShotCommand, error: unknown): OutputDocument {
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

async function execute(command: OneShotCommand, overrides?: RuntimeOverrides): Promise<OutputDocument> {
  const options = engineOptions(overrides);
  if (command === "init") return normalizeDocument(await initialize(options), "init");
  if (command === "sync") return normalizeDocument(await synchronize(options), "sync");
  return normalizeDocument(await inspect(options), command);
}

function timestamped(write: (chunk: string) => void, enabled: boolean): (chunk: string) => void {
  if (!enabled) return write;
  return (chunk) => {
    const prefix = `${new Date().toISOString()} `;
    write(chunk.split("\n").map((line, index, lines) => (
      line.length === 0 && index === lines.length - 1 ? "" : `${prefix}${line}`
    )).join("\n"));
  };
}

function writeWatchReport(io: CliIo, report: WatchReport, serviceLogging = false): void {
  const stdout = timestamped(io.stdout, serviceLogging);
  const stderr = timestamped(io.stderr, serviceLogging);
  if (report.type === "error") {
    const error = errorDetails(report.error);
    const retry = report.retryInMs > 0 ? `; retrying in ${report.retryInMs}ms` : "";
    stderr(`watch: ${report.phase} error: ${error.message}${retry}\n`);
    return;
  }
  if (report.type === "stopped") {
    stdout("watch: stopped\n");
    return;
  }

  const completed = report.document.actions?.filter((action) => action.status === "completed") ?? [];
  const reportableDiagnostics = (report.document.diagnostics ?? []).filter((entry) => entry.severity !== "info");
  const quietPeriodicCycle = serviceLogging
    && report.type === "cycle"
    && report.reasons.length === 1
    && report.reasons[0] === "periodic-scan"
    && report.document.status === "ok"
    && completed.length === 0
    && reportableDiagnostics.length === 0
    && report.pendingRemovals === 0;
  if (quietPeriodicCycle) return;

  const reason = report.type === "started" ? "initial sync" : report.reasons.join(", ");
  stdout(
    `watch: ${report.type} (${reason}): ${report.document.status}; `
    + `${report.watchedPaths.length} paths; ${report.pendingRemovals} pending removals\n`,
  );
  for (const action of completed) writeAction(stdout, action, "+");
  for (const diagnostic of reportableDiagnostics) {
    const scope = diagnostic.scopePath === undefined ? "" : ` [${diagnostic.scopePath}]`;
    stderr(`${diagnostic.severity}${scope}: ${diagnostic.message}\n`);
  }
}

async function executeWatch(io: CliIo, overrides?: RuntimeOverrides): Promise<void> {
  const options = engineOptions(overrides);
  const controller = overrides?.signal === undefined ? new AbortController() : undefined;
  const signal = overrides?.signal ?? controller?.signal;
  if (signal === undefined) throw new Error("Unable to create a watcher abort signal");
  const abort = () => controller?.abort();
  let releaseLifetimeLock: (() => Promise<void>) | undefined;
  if (controller !== undefined) {
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
  }
  try {
    if (!signal.aborted) releaseLifetimeLock = await acquireWatchLifetimeLock(options.home);
    await watchFleet({
      ...overrides?.watch,
      engine: options,
      signal,
      onReport: (report) => writeWatchReport(
        io,
        report,
        options.env.OVERLORD_SERVICE === "launchd" || options.env.OVERLORD_SERVICE === "systemd",
      ),
    });
  } finally {
    if (releaseLifetimeLock !== undefined) await releaseLifetimeLock();
    if (controller !== undefined) {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
}

function commandPreview(command: ServiceCommand): string {
  return [command.executable, ...command.arguments].map((part) => JSON.stringify(part)).join(" ");
}

function writeServicePlan(io: CliIo, plan: ServicePlan): void {
  io.stdout("service install plan:\n");
  io.stdout(`  manager: ${plan.manager}\n`);
  io.stdout(`  service: ${plan.serviceId}\n`);
  io.stdout(`  definition: ${plan.definitionPath}\n`);
  io.stdout(`  receipt: ${plan.receiptPath}\n`);
  io.stdout(`  executable: ${plan.executable}\n`);
  io.stdout(`  git executable: ${plan.gitExecutable}\n`);
  for (const argument of plan.arguments) io.stdout(`  argument: ${argument}\n`);
  for (const [name, value] of Object.entries(plan.environment).sort(([left], [right]) => left.localeCompare(right))) {
    io.stdout(`  environment: ${name}=${value}\n`);
  }
  if (plan.stdoutLogPath !== undefined) io.stdout(`  stdout log: ${plan.stdoutLogPath}\n`);
  if (plan.stderrLogPath !== undefined) io.stdout(`  stderr log: ${plan.stderrLogPath}\n`);
  for (const command of plan.installCommands) io.stdout(`  install command: ${commandPreview(command)}\n`);
  for (const command of plan.uninstallCommands) io.stdout(`  uninstall command: ${commandPreview(command)}\n`);
  io.stdout("  uninstall preserves definitions, configuration, ledger state, Git history, and logs.\n");
  io.stdout("--- service definition ---\n");
  io.stdout(plan.definition);
  io.stdout("--- end service definition ---\n");
}

function writeServiceStatus(io: CliIo, status: ServiceStatus): void {
  io.stdout(`service status: ${status.healthy ? "ok" : "attention-required"}\n`);
  io.stdout(`  manager: ${status.plan.manager}\n`);
  io.stdout(`  service: ${status.plan.serviceId}\n`);
  io.stdout(`  definition: ${status.plan.definitionPath} (${status.state})\n`);
  io.stdout(`  receipt: ${status.plan.receiptPath}\n`);
  io.stdout(`  desired version: ${status.plan.version}\n`);
  io.stdout(`  desired executable: ${status.plan.executable}\n`);
  io.stdout(`  desired git executable: ${status.plan.gitExecutable}\n`);
  io.stdout(`  desired arguments: ${status.plan.arguments.map((value) => JSON.stringify(value)).join(" ")}\n`);
  if (status.receipt !== undefined) {
    io.stdout(`  installed version: ${status.receipt.version}\n`);
    io.stdout(`  installed executable: ${status.receipt.executable}\n`);
    io.stdout(`  installed git executable: ${status.receipt.gitExecutable}\n`);
    io.stdout(`  installed arguments: ${status.receipt.arguments.map((value) => JSON.stringify(value)).join(" ")}\n`);
  }
  io.stdout(`  reachable: ${status.manager.reachable ? "yes" : "no"}\n`);
  io.stdout(`  loaded: ${status.manager.loaded ? "yes" : "no"}\n`);
  io.stdout(`  active: ${status.manager.active ? "yes" : "no"}\n`);
  if (status.manager.enabled !== null) io.stdout(`  enabled: ${status.manager.enabled ? "yes" : "no"}\n`);
  if (status.reason !== undefined) io.stderr(`service: ${status.reason}\n`);
  if (status.manager.detail !== undefined) io.stderr(`service manager: ${status.manager.detail}\n`);
}

async function assertCleanServiceBaseline(overrides: RuntimeOverrides | undefined): Promise<void> {
  const document = await inspect(engineOptions(overrides));
  if (document.status !== "ok") {
    throw new UsageError("The fleet requires attention; review 'overlord status', synchronize intentionally, and require a clean 'overlord check' before installing the service");
  }
}

async function assertNoForegroundWatcher(options: ServiceOptions, status: ServiceStatus): Promise<void> {
  if (status.receipt !== undefined && status.manager.active) return;
  const release = await acquireWatchLifetimeLock(options.home);
  await release();
}

async function executeService(
  action: ServiceAction,
  dryRun: boolean,
  io: CliIo,
  overrides?: RuntimeOverrides,
): Promise<number> {
  const options = serviceOptions(overrides);
  if (action === "install") {
    const plan = await planService(options);
    writeServicePlan(io, plan);
    if (!dryRun) {
      await assertCleanServiceBaseline(overrides);
      const status = await inspectService(options);
      await assertNoForegroundWatcher(options, status);
    }
    const result = await installService({ ...options, dryRun });
    io.stdout(`service install: ${dryRun ? "dry-run" : result.after.healthy ? "ok" : "attention-required"}\n`);
    for (const actionLine of result.actions) io.stdout(`  ${actionLine}\n`);
    if (!dryRun) writeServiceStatus(io, result.after);
    return dryRun || result.after.healthy ? 0 : 1;
  }

  if (action === "status") {
    const status = await inspectService(options);
    writeServiceStatus(io, status);
    return status.healthy ? 0 : 1;
  }

  if (action === "logs") {
    const logs = await readServiceLogs(options);
    io.stdout(`service logs: ${logs.plan.serviceId}\n`);
    io.stdout("--- stdout ---\n");
    io.stdout(logs.stdout.length === 0 ? "(empty)\n" : `${logs.stdout.replace(/\n?$/, "\n")}`);
    io.stdout("--- stderr ---\n");
    io.stdout(logs.stderr.length === 0 ? "(empty)\n" : `${logs.stderr.replace(/\n?$/, "\n")}`);
    return 0;
  }

  const result = await uninstallService(options);
  io.stdout(`service uninstall: ${result.after.state === "absent" ? "ok" : "attention-required"}\n`);
  for (const actionLine of result.actions) io.stdout(`  ${actionLine}\n`);
  writeServiceStatus(io, result.after);
  return result.after.state === "absent" && !result.after.manager.loaded ? 0 : 1;
}

/** Run one CLI invocation without terminating the host process. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  runtimeOverrides?: RuntimeOverrides,
): Promise<number> {
  const json = wantsJson(argv) && !argv.includes("watch") && !argv.includes("service");
  const command = fallbackCommand(argv);
  try {
    assertSupportedRuntime();
    const outcome = parseArguments(argv);
    if (outcome.kind !== "run") {
      if (outcome.kind === "help") io.stdout(usage(outcome.command, outcome.serviceAction));
      else io.stdout(`${packageVersion}\n`);
      return 0;
    }
    if (outcome.arguments.command === "watch") {
      await executeWatch(io, runtimeOverrides);
      return 0;
    }
    if (outcome.arguments.command === "service") {
      return await executeService(
        outcome.arguments.serviceAction as ServiceAction,
        outcome.arguments.dryRun,
        io,
        runtimeOverrides,
      );
    }
    const document = await execute(outcome.arguments.command, runtimeOverrides);
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
