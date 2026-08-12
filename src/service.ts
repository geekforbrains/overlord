import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireScopeLock,
  assertNoSymlinkedParent,
  replaceFileAtomic,
  writeFileAtomicExclusive,
} from "./filesystem.js";
import {
  LAUNCHD_SERVICE_ID,
  launchdDomain,
  launchdServiceTarget,
  renderLaunchdDefinition,
} from "./service-launchd.js";
import { SYSTEMD_SERVICE_ID, renderSystemdDefinition } from "./service-systemd.js";

const RECEIPT_FORMAT_VERSION = 2 as const;
const DEFAULT_LOG_BYTES = 64 * 1024;
const DEFAULT_LOG_LINES = 200;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const LAUNCHD_BOOTSTRAP_RETRY_DELAYS_MS = [100, 250, 500] as const;
// A watcher already inside a synchronization cycle is allowed to use the
// launchd ExitTimeOut before it exits. Keep ownership evidence in place while
// launchd retires the job, with a total wait just below that 60-second bound.
const LAUNCHD_BOOTOUT_SETTLE_DELAYS_MS = [
  50,
  100,
  250,
  500,
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  28_000,
] as const;
const SERVICE_ENVIRONMENT_NAMES = new Set([
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "OVERLORD_GIT_EXECUTABLE",
  "OVERLORD_SERVICE",
  "OVERLORD_SERVICE_VERSION",
  "PATH",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);
const RECEIPT_FIELDS = new Set([
  "formatVersion",
  "platform",
  "serviceId",
  "definitionPath",
  "definitionDigest",
  "executable",
  "gitExecutable",
  "arguments",
  "environment",
  "version",
  "stdoutLogPath",
  "stderrLogPath",
]);

export type ServicePlatform = "darwin" | "linux";
export type ServiceManager = "launchd" | "systemd";
export type ServiceDefinitionState = "absent" | "current" | "stale" | "modified" | "collision";

export interface ServiceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ServiceCommandRunner {
  run(executable: string, arguments_: readonly string[]): Promise<ServiceCommandResult>;
}

export interface ServicePathOverrides {
  definitionPath?: string;
  receiptPath?: string;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  launchctlPath?: string;
  systemctlPath?: string;
  journalctlPath?: string;
}

export interface ServiceOptions {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  uid?: number;
  nodePath?: string;
  gitPath?: string;
  cliPath?: string;
  version?: string;
  runner?: ServiceCommandRunner;
  paths?: ServicePathOverrides;
}

export interface InstallServiceOptions extends ServiceOptions {
  dryRun?: boolean;
}

export interface ServiceCommand {
  executable: string;
  arguments: string[];
}

export interface ServicePlan {
  platform: ServicePlatform;
  manager: ServiceManager;
  uid: number;
  serviceId: string;
  definitionPath: string;
  receiptPath: string;
  executable: string;
  gitExecutable: string;
  arguments: string[];
  environment: Readonly<Record<string, string>>;
  definition: string;
  definitionDigest: string;
  version: string;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  installCommands: ServiceCommand[];
  uninstallCommands: ServiceCommand[];
  logsCommand?: ServiceCommand;
}

export interface ServiceReceipt {
  formatVersion: 1 | 2;
  platform: ServicePlatform;
  serviceId: string;
  definitionPath: string;
  definitionDigest: string;
  executable: string;
  gitExecutable: string;
  arguments: string[];
  environment: Record<string, string>;
  version: string;
  stdoutLogPath?: string;
  stderrLogPath?: string;
}

export interface ServiceManagerStatus {
  reachable: boolean;
  loaded: boolean;
  active: boolean;
  enabled: boolean | null;
  detail?: string;
}

export interface ServiceStatus {
  plan: ServicePlan;
  state: ServiceDefinitionState;
  reason?: string;
  receipt?: ServiceReceipt;
  manager: ServiceManagerStatus;
  healthy: boolean;
}

export interface ServiceOperationResult {
  plan: ServicePlan;
  before: ServiceStatus;
  after: ServiceStatus;
  changed: boolean;
  dryRun: boolean;
  actions: string[];
}

export interface ServiceLogs {
  plan: ServicePlan;
  stdout: string;
  stderr: string;
}

export class ServiceError extends Error {
  readonly code: "usage" | "permission-denied" | "internal";
  readonly path?: string;
  readonly detail?: string;

  constructor(
    code: "usage" | "permission-denied" | "internal",
    message: string,
    options?: { path?: string; detail?: string },
  ) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    if (options?.path !== undefined) this.path = options.path;
    if (options?.detail !== undefined) this.detail = options.detail;
  }
}

interface FileSnapshot {
  contents: Buffer;
  digest: string;
  mode: number;
  uid: number;
}

interface DefinitionInspection {
  state: ServiceDefinitionState;
  reason?: string;
  receipt?: ServiceReceipt;
  definition?: FileSnapshot;
  receiptFile?: FileSnapshot;
}

function digest(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new ServiceError("usage", `${label} must be an absolute path: ${value}`);
  const normalized = resolve(value);
  assertSafeText(normalized, label);
  return normalized;
}

function assertSafeText(value: string, label: string): void {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || code === 10 || code === 13 || code < 32 || code === 127) {
      throw new ServiceError("usage", `${label} contains unsupported control characters`);
    }
  }
}

function resolvedEnvironmentPath(value: string | undefined, fallback: string, home: string): string {
  if (value === undefined || value.length === 0) return resolve(fallback);
  return resolve(isAbsolute(value) ? value : join(home, value));
}

function stablePath(nodePath: string, gitPath: string): string {
  return [...new Set([
    dirname(nodePath),
    dirname(gitPath),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(delimiter);
}

async function physicalFile(value: string, label: string): Promise<string> {
  const candidate = absolutePath(value, label);
  let physical: string;
  try {
    physical = await realpath(candidate);
  } catch (error) {
    throw new ServiceError("permission-denied", `${label} does not resolve to a physical file: ${candidate}`, {
      path: candidate,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const metadata = await lstat(physical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ServiceError("permission-denied", `${label} must resolve to a physical file: ${candidate}`, {
      path: candidate,
    });
  }
  return physical;
}

async function executableFromPath(name: string, value: string | undefined): Promise<string> {
  const directories = [
    ...(value ?? "").split(delimiter),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
  ];
  for (const directory of new Set(directories)) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    const candidate = join(resolve(directory), name);
    try {
      const physical = await realpath(candidate);
      const current = await lstat(physical);
      if (!current.isFile() || current.isSymbolicLink()) continue;
      await access(physical, fsConstants.X_OK);
      return physical;
    } catch {
      // Continue through the deterministic search list.
    }
  }
  throw new ServiceError(
    "permission-denied",
    `A physical ${name} executable is required to run the Overlord service`,
  );
}

async function packageVersion(): Promise<string> {
  try {
    const source = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(source) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function truncatedAppend(chunks: Buffer[], currentLength: number, chunk: Buffer): number {
  if (currentLength >= MAX_COMMAND_OUTPUT_BYTES) return currentLength;
  const remaining = MAX_COMMAND_OUTPUT_BYTES - currentLength;
  chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
  return Math.min(MAX_COMMAND_OUTPUT_BYTES, currentLength + chunk.length);
}

const defaultRunner: ServiceCommandRunner = {
  run(executable, arguments_) {
    return new Promise<ServiceCommandResult>((accept, reject) => {
      const child = spawn(executable, [...arguments_], { stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutLength = 0;
      let stderrLength = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutLength = truncatedAppend(stdout, stdoutLength, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrLength = truncatedAppend(stderr, stderrLength, chunk);
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        accept({
          exitCode: code ?? (signal === null ? 1 : 128),
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  },
};

function runner(options: ServiceOptions): ServiceCommandRunner {
  return options.runner ?? defaultRunner;
}

function exactCommand(executable: string, ...arguments_: string[]): ServiceCommand {
  return { executable, arguments: arguments_ };
}

function environmentFor(
  options: ServiceOptions,
  home: string,
  version: string,
  manager: ServiceManager,
  nodePath: string,
  gitPath: string,
): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: home,
    CLAUDE_CONFIG_DIR: resolvedEnvironmentPath(options.env.CLAUDE_CONFIG_DIR, join(home, ".claude"), home),
    CODEX_HOME: resolvedEnvironmentPath(options.env.CODEX_HOME, join(home, ".codex"), home),
    XDG_CACHE_HOME: resolvedEnvironmentPath(options.env.XDG_CACHE_HOME, join(home, ".cache"), home),
    XDG_CONFIG_HOME: resolvedEnvironmentPath(options.env.XDG_CONFIG_HOME, join(home, ".config"), home),
    XDG_DATA_HOME: resolvedEnvironmentPath(options.env.XDG_DATA_HOME, join(home, ".local", "share"), home),
    XDG_STATE_HOME: resolvedEnvironmentPath(options.env.XDG_STATE_HOME, join(home, ".local", "state"), home),
    PATH: stablePath(nodePath, gitPath),
    OVERLORD_GIT_EXECUTABLE: gitPath,
    OVERLORD_SERVICE: manager,
    OVERLORD_SERVICE_VERSION: version,
  };
  for (const [name, value] of Object.entries(environment)) assertSafeText(value, `Environment ${name}`);
  return Object.fromEntries(Object.entries(environment).sort(([left], [right]) => compareText(left, right)));
}

function resolvedUid(options: ServiceOptions): number {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new ServiceError("usage", "A numeric user ID is required to manage a user service");
  }
  if (uid === 0) {
    throw new ServiceError("permission-denied", "Refusing to install or manage an Overlord user service as root");
  }
  return uid;
}

/** Resolve the exact platform definition and runtime captured by an installed service. */
export async function planService(options: ServiceOptions): Promise<ServicePlan> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new ServiceError("usage", `User services are supported only on macOS and Linux (running ${platform})`);
  }
  const uid = resolvedUid(options);
  const home = absolutePath(options.home, "Home directory");
  const nodePath = await physicalFile(options.nodePath ?? process.execPath, "Node executable");
  const gitPath = options.gitPath === undefined
    ? await executableFromPath("git", options.env.PATH)
    : await physicalFile(options.gitPath, "Git executable");
  await access(gitPath, fsConstants.X_OK).catch((error: unknown) => {
    throw new ServiceError("permission-denied", `Git executable is not executable: ${gitPath}`, {
      path: gitPath,
      detail: error instanceof Error ? error.message : String(error),
    });
  });
  const defaultCliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const cliPath = await physicalFile(options.cliPath ?? defaultCliPath, "Overlord CLI");
  const version = options.version ?? await packageVersion();
  assertSafeText(version, "Overlord version");
  const environment = environmentFor(
    options,
    home,
    version,
    platform === "darwin" ? "launchd" : "systemd",
    nodePath,
    gitPath,
  );

  if (platform === "darwin") {
    const serviceId = LAUNCHD_SERVICE_ID;
    const launchctlPath = absolutePath(options.paths?.launchctlPath ?? "/bin/launchctl", "launchctl path");
    const definitionPath = absolutePath(
      options.paths?.definitionPath ?? join(home, "Library", "LaunchAgents", `${serviceId}.plist`),
      "Service definition path",
    );
    const receiptPath = absolutePath(
      options.paths?.receiptPath ?? join(home, "Library", "Application Support", "Overlord", "service.json"),
      "Service receipt path",
    );
    const stdoutLogPath = absolutePath(
      options.paths?.stdoutLogPath ?? join(home, "Library", "Logs", "Overlord", "watch.log"),
      "Service stdout log path",
    );
    const stderrLogPath = absolutePath(
      options.paths?.stderrLogPath ?? join(home, "Library", "Logs", "Overlord", "watch-error.log"),
      "Service stderr log path",
    );
    const definition = renderLaunchdDefinition({
      serviceId,
      nodePath,
      cliPath,
      home,
      environment,
      stdoutPath: stdoutLogPath,
      stderrPath: stderrLogPath,
    });
    const domain = launchdDomain(uid);
    const target = launchdServiceTarget(uid, serviceId);
    return {
      platform,
      manager: "launchd",
      uid,
      serviceId,
      definitionPath,
      receiptPath,
      executable: nodePath,
      gitExecutable: gitPath,
      arguments: [cliPath, "watch"],
      environment,
      definition,
      definitionDigest: digest(definition),
      version,
      stdoutLogPath,
      stderrLogPath,
      installCommands: [
        exactCommand(launchctlPath, "enable", target),
        exactCommand(launchctlPath, "bootstrap", domain, definitionPath),
        exactCommand(launchctlPath, "kickstart", target),
      ],
      uninstallCommands: [
        exactCommand(launchctlPath, "bootout", target),
        exactCommand(launchctlPath, "disable", target),
      ],
    };
  }

  const serviceId = SYSTEMD_SERVICE_ID;
  const systemctlPath = absolutePath(options.paths?.systemctlPath ?? "/usr/bin/systemctl", "systemctl path");
  const journalctlPath = absolutePath(options.paths?.journalctlPath ?? "/usr/bin/journalctl", "journalctl path");
  const definitionPath = absolutePath(
    options.paths?.definitionPath ?? join(environment.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user", serviceId),
    "Service definition path",
  );
  const receiptPath = absolutePath(
    options.paths?.receiptPath ?? join(environment.XDG_STATE_HOME ?? join(home, ".local", "state"), "overlord", "service.json"),
    "Service receipt path",
  );
  const definition = renderSystemdDefinition({ serviceId, nodePath, cliPath, home, environment });
  return {
    platform,
    manager: "systemd",
    uid,
    serviceId,
    definitionPath,
    receiptPath,
    executable: nodePath,
    gitExecutable: gitPath,
    arguments: [cliPath, "watch"],
    environment,
    definition,
    definitionDigest: digest(definition),
    version,
    installCommands: [
      exactCommand(systemctlPath, "--user", "daemon-reload"),
      exactCommand(systemctlPath, "--user", "enable", serviceId),
      exactCommand(systemctlPath, "--user", "restart", serviceId),
    ],
    uninstallCommands: [
      exactCommand(systemctlPath, "--user", "disable", "--now", serviceId),
      exactCommand(systemctlPath, "--user", "daemon-reload"),
    ],
    logsCommand: exactCommand(
      journalctlPath,
      "--user",
      `--unit=${serviceId}`,
      "--no-pager",
      `--lines=${DEFAULT_LOG_LINES}`,
      "--output=short-iso",
    ),
  };
}

async function metadata(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function serviceBoundary(plan: ServicePlan, path: string): string {
  const home = plan.environment.HOME ?? parse(path).root;
  const nested = relative(home, path);
  return nested !== ".." && !nested.startsWith(`..${sep}`) ? home : parse(path).root;
}

async function assertPhysicalFileParents(path: string, boundary: string): Promise<void> {
  const absolute = absolutePath(path, "Service-owned path");
  await assertNoSymlinkedParent(absolute, boundary);
}

async function snapshot(path: string, boundary: string): Promise<FileSnapshot | undefined> {
  await assertPhysicalFileParents(path, boundary);
  const current = await metadata(path);
  if (current === undefined) return undefined;
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new ServiceError("permission-denied", `Service-owned path must be a physical file: ${path}`, { path });
  }
  const contents = await readFile(path);
  return {
    contents,
    digest: digest(contents),
    mode: Number(current.mode) & 0o777,
    uid: Number(current.uid),
  };
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.digest === right.digest && left.mode === right.mode && left.uid === right.uid;
}

function expectedPublishedSnapshot(contents: string): FileSnapshot {
  return {
    contents: Buffer.from(contents),
    digest: digest(contents),
    mode: 0o600,
    uid: process.getuid?.() ?? 0,
  };
}

function receiptFor(plan: ServicePlan): ServiceReceipt {
  const receipt: ServiceReceipt = {
    formatVersion: RECEIPT_FORMAT_VERSION,
    platform: plan.platform,
    serviceId: plan.serviceId,
    definitionPath: plan.definitionPath,
    definitionDigest: plan.definitionDigest,
    executable: plan.executable,
    gitExecutable: plan.gitExecutable,
    arguments: [...plan.arguments],
    environment: { ...plan.environment },
    version: plan.version,
  };
  if (plan.stdoutLogPath !== undefined) receipt.stdoutLogPath = plan.stdoutLogPath;
  if (plan.stderrLogPath !== undefined) receipt.stderrLogPath = plan.stderrLogPath;
  return receipt;
}

function renderReceipt(receipt: ServiceReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function reconstructedReceiptDefinition(receipt: ServiceReceipt): string | undefined {
  const cliPath = receipt.arguments[0];
  const home = receipt.environment.HOME;
  if (cliPath === undefined || home === undefined) return undefined;
  if (receipt.platform === "darwin") {
    if (receipt.stdoutLogPath === undefined || receipt.stderrLogPath === undefined) return undefined;
    return renderLaunchdDefinition({
      serviceId: receipt.serviceId,
      nodePath: receipt.executable,
      cliPath,
      home,
      environment: receipt.environment,
      stdoutPath: receipt.stdoutLogPath,
      stderrPath: receipt.stderrLogPath,
      exitTimeOutSeconds: receipt.formatVersion === 1 ? 120 : 60,
    });
  }
  if (receipt.stdoutLogPath !== undefined || receipt.stderrLogPath !== undefined) return undefined;
  return renderSystemdDefinition({
    serviceId: receipt.serviceId,
    nodePath: receipt.executable,
    cliPath,
    home,
    environment: receipt.environment,
    escapeExecDollar: receipt.formatVersion !== 1,
  });
}

function receiptMetadataIsCoherent(receipt: ServiceReceipt): boolean {
  const manager: ServiceManager = receipt.platform === "darwin" ? "launchd" : "systemd";
  const expectedServiceId = receipt.platform === "darwin" ? LAUNCHD_SERVICE_ID : SYSTEMD_SERVICE_ID;
  const absoluteValues = [
    receipt.definitionPath,
    receipt.executable,
    receipt.gitExecutable,
    receipt.arguments[0] ?? "",
    receipt.environment.HOME ?? "",
    receipt.environment.CLAUDE_CONFIG_DIR ?? "",
    receipt.environment.CODEX_HOME ?? "",
    receipt.environment.XDG_CACHE_HOME ?? "",
    receipt.environment.XDG_CONFIG_HOME ?? "",
    receipt.environment.XDG_DATA_HOME ?? "",
    receipt.environment.XDG_STATE_HOME ?? "",
    ...(receipt.stdoutLogPath === undefined ? [] : [receipt.stdoutLogPath]),
    ...(receipt.stderrLogPath === undefined ? [] : [receipt.stderrLogPath]),
  ];
  if (
    receipt.serviceId !== expectedServiceId
    || receipt.arguments.length !== 2
    || receipt.arguments[1] !== "watch"
    || absoluteValues.some((value) => !isAbsolute(value) || resolve(value) !== value)
    || receipt.environment.OVERLORD_SERVICE !== manager
    || receipt.environment.OVERLORD_SERVICE_VERSION !== receipt.version
    || receipt.environment.OVERLORD_GIT_EXECUTABLE !== receipt.gitExecutable
    || receipt.environment.PATH !== stablePath(receipt.executable, receipt.gitExecutable)
  ) return false;

  try {
    for (const [name, value] of Object.entries(receipt.environment)) {
      assertSafeText(value, `Receipt environment ${name}`);
    }
    for (const value of [
      receipt.serviceId,
      receipt.definitionPath,
      receipt.executable,
      receipt.gitExecutable,
      ...receipt.arguments,
      receipt.version,
      receipt.stdoutLogPath ?? "",
      receipt.stderrLogPath ?? "",
    ]) assertSafeText(value, "Receipt value");
  } catch {
    return false;
  }

  const reconstructed = reconstructedReceiptDefinition(receipt);
  return reconstructed !== undefined && digest(reconstructed) === receipt.definitionDigest;
}

function parseReceipt(contents: Buffer, path: string): ServiceReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw new ServiceError("permission-denied", `Service receipt is not valid JSON: ${path}`, {
      path,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ServiceError("permission-denied", `Service receipt has an unsupported format: ${path}`, { path });
  }
  const record = parsed as Partial<ServiceReceipt>;
  const recordKeysValid = Object.keys(record).every((key) => RECEIPT_FIELDS.has(key));
  const environmentKeys = record.environment !== null && typeof record.environment === "object"
    ? Object.keys(record.environment)
    : [];
  if (
    !recordKeysValid
    || (record.formatVersion !== 1 && record.formatVersion !== RECEIPT_FORMAT_VERSION)
    || (record.platform !== "darwin" && record.platform !== "linux")
    || typeof record.serviceId !== "string"
    || typeof record.definitionPath !== "string"
    || typeof record.definitionDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(record.definitionDigest)
    || typeof record.executable !== "string"
    || typeof record.gitExecutable !== "string"
    || !Array.isArray(record.arguments)
    || !record.arguments.every((entry) => typeof entry === "string")
    || record.environment === null
    || typeof record.environment !== "object"
    || Array.isArray(record.environment)
    || !Object.values(record.environment).every((entry) => typeof entry === "string")
    || environmentKeys.length !== SERVICE_ENVIRONMENT_NAMES.size
    || !environmentKeys.every((key) => SERVICE_ENVIRONMENT_NAMES.has(key))
    || typeof record.version !== "string"
    || (record.stdoutLogPath !== undefined && typeof record.stdoutLogPath !== "string")
    || (record.stderrLogPath !== undefined && typeof record.stderrLogPath !== "string")
  ) {
    throw new ServiceError("permission-denied", `Service receipt has an unsupported format: ${path}`, { path });
  }
  const receipt = record as ServiceReceipt;
  if (!receiptMetadataIsCoherent(receipt)) {
    throw new ServiceError("permission-denied", `Service receipt metadata does not match its definition: ${path}`, {
      path,
    });
  }
  return receipt;
}

async function inspectDefinition(plan: ServicePlan): Promise<DefinitionInspection> {
  const [definition, receiptFile] = await Promise.all([
    snapshot(plan.definitionPath, serviceBoundary(plan, plan.definitionPath)),
    snapshot(plan.receiptPath, serviceBoundary(plan, plan.receiptPath)),
  ]);
  if (definition === undefined && receiptFile === undefined) return { state: "absent" };
  if (receiptFile === undefined) {
    const result: DefinitionInspection = {
      state: "collision",
      reason: `A service definition exists without an Overlord ownership receipt: ${plan.definitionPath}`,
    };
    if (definition !== undefined) result.definition = definition;
    return result;
  }

  const expectedUid = process.getuid?.();
  const unsafeOwnedFile = [definition, receiptFile].find((entry) => (
    entry !== undefined
    && (entry.mode !== 0o600 || (expectedUid !== undefined && expectedUid !== 0 && entry.uid !== expectedUid))
  ));
  if (unsafeOwnedFile !== undefined) {
    const result: DefinitionInspection = {
      state: "modified",
      reason: "Service definition and receipt must be mode 0600 files owned by the current user",
      receiptFile,
    };
    if (definition !== undefined) result.definition = definition;
    return result;
  }

  let receipt: ServiceReceipt;
  try {
    receipt = parseReceipt(receiptFile.contents, plan.receiptPath);
  } catch (error) {
    const result: DefinitionInspection = {
      state: "modified",
      reason: error instanceof Error ? error.message : String(error),
      receiptFile,
    };
    if (definition !== undefined) result.definition = definition;
    return result;
  }
  if (
    receipt.platform !== plan.platform
    || receipt.serviceId !== plan.serviceId
    || resolve(receipt.definitionPath) !== plan.definitionPath
  ) {
    const result: DefinitionInspection = {
      state: "modified",
      reason: "The service ownership receipt does not match this platform service",
      receipt,
      receiptFile,
    };
    if (definition !== undefined) result.definition = definition;
    return result;
  }
  if (definition === undefined) {
    return {
      state: "modified",
      reason: "The owned service definition is missing",
      receipt,
      receiptFile,
    };
  }
  if (definition.digest !== receipt.definitionDigest) {
    return {
      state: "modified",
      reason: `The service definition was modified outside Overlord: ${plan.definitionPath}`,
      receipt,
      definition,
      receiptFile,
    };
  }
  return {
    state: definition.digest === plan.definitionDigest ? "current" : "stale",
    receipt,
    definition,
    receiptFile,
  };
}

function commandDetail(result: ServiceCommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exited with status ${result.exitCode}`;
}

async function runRequired(
  commandRunner: ServiceCommandRunner,
  command: ServiceCommand,
  description: string,
): Promise<ServiceCommandResult> {
  let result: ServiceCommandResult;
  try {
    result = await commandRunner.run(command.executable, command.arguments);
  } catch (error) {
    throw new ServiceError("internal", `${description} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.exitCode !== 0) {
    throw new ServiceError("internal", `${description} failed: ${commandDetail(result)}`, {
      detail: commandDetail(result),
    });
  }
  return result;
}

async function runBestEffort(commandRunner: ServiceCommandRunner, command: ServiceCommand): Promise<void> {
  try {
    await commandRunner.run(command.executable, command.arguments);
  } catch {
    // Rollback and cleanup are best effort; the primary failure is preserved.
  }
}

function isTransientLaunchdBootstrapError(command: ServiceCommand, error: unknown): boolean {
  if (command.arguments[0] !== "bootstrap" || !(error instanceof ServiceError)) return false;
  return /Bootstrap failed:\s*5:\s*Input\/output error/iu.test(error.detail ?? error.message);
}

async function waitFor(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function runActivationRequired(
  commandRunner: ServiceCommandRunner,
  command: ServiceCommand,
  description: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await runRequired(commandRunner, command, description);
      return;
    } catch (error) {
      const delay = LAUNCHD_BOOTSTRAP_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientLaunchdBootstrapError(command, error)) throw error;
      await waitFor(delay);
    }
  }
}

async function managerStatus(plan: ServicePlan, commandRunner: ServiceCommandRunner): Promise<ServiceManagerStatus> {
  if (plan.manager === "launchd") {
    const executable = plan.installCommands[0]?.executable;
    if (executable === undefined) throw new ServiceError("internal", "launchd command plan is incomplete");
    let domainResult: ServiceCommandResult;
    try {
      domainResult = await commandRunner.run(executable, ["print", launchdDomain(plan.uid)]);
    } catch (error) {
      return {
        reachable: false,
        loaded: false,
        active: false,
        enabled: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (domainResult.exitCode !== 0) {
      return {
        reachable: false,
        loaded: false,
        active: false,
        enabled: null,
        detail: commandDetail(domainResult),
      };
    }
    let result: ServiceCommandResult;
    let disabledResult: ServiceCommandResult;
    try {
      [result, disabledResult] = await Promise.all([
        commandRunner.run(executable, ["print", launchdServiceTarget(plan.uid, plan.serviceId)]),
        commandRunner.run(executable, ["print-disabled", launchdDomain(plan.uid)]),
      ]);
    } catch (error) {
      return {
        reachable: false,
        loaded: false,
        active: false,
        enabled: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const loaded = result.exitCode === 0;
    const active = loaded && (
      /^\s*state\s*=\s*running\s*$/mu.test(result.stdout)
      || /^\s*pid\s*=\s*[1-9][0-9]*\s*$/mu.test(result.stdout)
    );
    let enabled: boolean | null = null;
    if (disabledResult.exitCode === 0) {
      for (const line of disabledResult.stdout.split("\n")) {
        const match = /^\s*"([^"]+)"\s*=>\s*(enabled|disabled)\s*$/u.exec(line);
        if (match?.[1] !== plan.serviceId) continue;
        enabled = match[2] === "enabled";
        break;
      }
    }
    const status: ServiceManagerStatus = {
      reachable: true,
      loaded,
      active,
      enabled,
    };
    if (loaded && !active) status.detail = "loaded but not running";
    else if (disabledResult.exitCode !== 0) status.detail = "enablement state unavailable";
    return status;
  }

  const executable = plan.installCommands[0]?.executable;
  if (executable === undefined) throw new ServiceError("internal", "systemd command plan is incomplete");
  let preflight: ServiceCommandResult;
  try {
    preflight = await commandRunner.run(executable, ["--user", "show-environment"]);
  } catch (error) {
    return {
      reachable: false,
      loaded: false,
      active: false,
      enabled: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (preflight.exitCode !== 0) {
    return {
      reachable: false,
      loaded: false,
      active: false,
      enabled: null,
      detail: commandDetail(preflight),
    };
  }
  let activeResult: ServiceCommandResult;
  let enabledResult: ServiceCommandResult;
  let loadedResult: ServiceCommandResult;
  try {
    [activeResult, enabledResult, loadedResult] = await Promise.all([
      commandRunner.run(executable, ["--user", "is-active", plan.serviceId]),
      commandRunner.run(executable, ["--user", "is-enabled", plan.serviceId]),
      commandRunner.run(executable, [
        "--user",
        "show",
        plan.serviceId,
        "--property=LoadState",
        "--value",
        "--no-pager",
      ]),
    ]);
  } catch (error) {
    return {
      reachable: false,
      loaded: false,
      active: false,
      enabled: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const activeState = activeResult.stdout.trim();
  const enabledState = enabledResult.stdout.trim();
  const loadedState = loadedResult.stdout.trim();
  const active = activeResult.exitCode === 0 && activeState === "active";
  const enabled = enabledResult.exitCode === 0 && [
    "enabled",
    "enabled-runtime",
    "linked",
    "linked-runtime",
    "alias",
  ].includes(enabledState);
  const loaded = active || (
    loadedResult.exitCode === 0
    && loadedState.length > 0
    && !["not-found", "error"].includes(loadedState)
  );
  const status: ServiceManagerStatus = {
    reachable: true,
    loaded,
    active,
    enabled,
  };
  return status;
}

async function waitForLaunchdBootout(
  plan: ServicePlan,
  commandRunner: ServiceCommandRunner,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const status = await managerStatus(plan, commandRunner);
    if (!status.reachable) {
      throw new ServiceError(
        "internal",
        "The launchd user manager became unavailable after bootout",
        status.detail === undefined ? undefined : { detail: status.detail },
      );
    }
    if (!status.loaded && !status.active) return;
    const delay = LAUNCHD_BOOTOUT_SETTLE_DELAYS_MS[attempt];
    if (delay === undefined) {
      throw new ServiceError("internal", `Stopping ${plan.serviceId} did not settle in launchd`);
    }
    await waitFor(delay);
  }
}

async function inspectWithPlan(
  plan: ServicePlan,
  options: ServiceOptions,
  queryManager = true,
): Promise<ServiceStatus> {
  const definition = await inspectDefinition(plan);
  const manager = queryManager
    ? await managerStatus(plan, runner(options))
    : { reachable: false, loaded: false, active: false, enabled: null };
  const managerCollision = queryManager
    && definition.state === "absent"
    && (manager.loaded || manager.enabled === true);
  const state = managerCollision ? "collision" : definition.state;
  const reason = managerCollision
    ? `The service manager already has '${plan.serviceId}' without an Overlord-owned definition and receipt`
    : definition.reason;
  const healthy = state === "current"
    && manager.active
    && manager.enabled !== false;
  const status: ServiceStatus = { plan, state, manager, healthy };
  if (reason !== undefined) status.reason = reason;
  if (definition.receipt !== undefined) status.receipt = definition.receipt;
  return status;
}

/** Inspect definition ownership, runtime drift, and service-manager state without mutation. */
export async function inspectService(options: ServiceOptions): Promise<ServiceStatus> {
  const plan = await planService(options);
  return inspectWithPlan(plan, options);
}

async function ensurePhysicalDirectory(path: string, boundary: string): Promise<void> {
  const normalized = absolutePath(path, "Service directory");
  const probe = join(normalized, ".overlord-physical-directory-probe");
  await assertNoSymlinkedParent(probe, boundary);
  let ancestor = normalized;
  while (true) {
    const current = await metadata(ancestor);
    if (current !== undefined) {
      if (current.isSymbolicLink() || !current.isDirectory()) {
        throw new ServiceError("permission-denied", `Service directory must be physical: ${ancestor}`, { path: ancestor });
      }
      break;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  await mkdir(normalized, { recursive: true, mode: 0o700 });
  await assertNoSymlinkedParent(probe, boundary);
  const created = await lstat(normalized);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new ServiceError("permission-denied", `Service directory must be physical: ${normalized}`, { path: normalized });
  }
}

async function publishFile(
  path: string,
  contents: string,
  boundary: string,
  expected?: FileSnapshot,
): Promise<void> {
  await ensurePhysicalDirectory(dirname(path), boundary);
  const current = await snapshot(path, boundary);
  if (expected === undefined) {
    if (current !== undefined) {
      throw new ServiceError("permission-denied", `Refusing to replace an unowned service file: ${path}`, { path });
    }
    await writeFileAtomicExclusive(path, contents, 0o600);
    return;
  }
  if (current === undefined || !sameSnapshot(current, expected)) {
    throw new ServiceError("permission-denied", `Service file changed before replacement: ${path}`, { path });
  }
  await replaceFileAtomic(path, contents, 0o600);
}

async function removeFile(path: string, boundary: string, expected: FileSnapshot | undefined): Promise<void> {
  if (expected === undefined) return;
  const current = await snapshot(path, boundary);
  if (current === undefined) return;
  if (!sameSnapshot(current, expected)) {
    throw new ServiceError("permission-denied", `Service file changed before removal: ${path}`, { path });
  }
  await rm(path);
}

async function validateLaunchdLogPath(plan: ServicePlan, path: string): Promise<void> {
  const boundary = serviceBoundary(plan, path);
  await assertPhysicalFileParents(path, boundary);
  const current = await metadata(path);
  if (current === undefined) return;
  const uid = process.getuid?.();
  if (
    current.isSymbolicLink()
    || !current.isFile()
    || (uid !== undefined && uid !== 0 && Number(current.uid) !== uid)
  ) {
    throw new ServiceError(
      "permission-denied",
      `Service log path must be absent or a physical file owned by the current user: ${path}`,
      { path },
    );
  }
}

function establishesManagerOwnership(plan: ServicePlan, command: ServiceCommand): boolean {
  if (plan.manager === "launchd") return command.arguments[0] === "bootstrap";
  return command.arguments[0] === "--user" && command.arguments[1] === "enable";
}

async function activateService(
  plan: ServicePlan,
  commandRunner: ServiceCommandRunner,
  before: ServiceManagerStatus,
  onApplied: (command: ServiceCommand) => void,
): Promise<void> {
  for (const command of plan.installCommands) {
    if (
      plan.manager === "launchd"
      && command.arguments[0] === "enable"
      && before.enabled !== false
    ) continue;
    await runActivationRequired(commandRunner, command, `Activating ${plan.serviceId}`);
    onApplied(command);
  }
}

async function stopService(plan: ServicePlan, commandRunner: ServiceCommandRunner): Promise<void> {
  const first = plan.uninstallCommands[0];
  if (first !== undefined) await runRequired(commandRunner, first, `Stopping ${plan.serviceId}`);
}

async function rollbackInstall(
  plan: ServicePlan,
  commandRunner: ServiceCommandRunner,
  previousDefinition: FileSnapshot | undefined,
  previousReceipt: FileSnapshot | undefined,
  previousManager: ServiceManagerStatus,
  managerMutated: boolean,
  managerOwned: boolean,
  definitionPublished: boolean,
  receiptPublished: boolean,
): Promise<void> {
  if (managerOwned) {
    if (plan.manager === "launchd") {
      const current = await managerStatus(plan, commandRunner);
      if (!current.reachable) {
        throw new ServiceError(
          "internal",
          "The launchd user manager became unavailable during install rollback",
          current.detail === undefined ? undefined : { detail: current.detail },
        );
      }
      if (current.loaded || current.active) {
        const command = plan.uninstallCommands[0];
        if (command === undefined) {
          throw new ServiceError("internal", "The launchd rollback command plan is incomplete");
        }
        await runRequired(commandRunner, command, `Stopping ${plan.serviceId} during install rollback`);
        await waitForLaunchdBootout(plan, commandRunner);
      }
    } else {
      const executable = plan.installCommands[0]?.executable;
      if (executable === undefined) {
        throw new ServiceError("internal", "The systemd rollback command plan is incomplete");
      }
      await runRequired(
        commandRunner,
        exactCommand(executable, "--user", "disable", "--now", plan.serviceId),
        `Stopping ${plan.serviceId} during install rollback`,
      );
    }
  }

  await restoreInstallSnapshot(
    plan,
    plan.definitionPath,
    previousDefinition,
    plan.definition,
    definitionPublished,
    "definition",
  );
  await restoreInstallSnapshot(
    plan,
    plan.receiptPath,
    previousReceipt,
    renderReceipt(receiptFor(plan)),
    receiptPublished,
    "receipt",
  );
  await assertRollbackSnapshots(plan, previousDefinition, previousReceipt, "install");

  if (plan.manager === "systemd") {
    if (managerMutated) await restoreManagerAfterRollback(plan, commandRunner, previousManager, "install");
  } else if (managerMutated) {
    if (managerOwned || previousManager.loaded) {
      await restoreManagerAfterRollback(plan, commandRunner, previousManager, "install");
    } else {
      const current = await managerStatus(plan, commandRunner);
      if (current.reachable && !current.loaded) {
        await restoreManagerAfterRollback(plan, commandRunner, previousManager, "install");
      }
    }
  }
  await verifyRollbackManager(plan, commandRunner, previousManager, "install");
}

function optionalSnapshotsMatch(current: FileSnapshot | undefined, expected: FileSnapshot | undefined): boolean {
  if (current === undefined || expected === undefined) return current === expected;
  return sameSnapshot(current, expected);
}

async function restoreInstallSnapshot(
  plan: ServicePlan,
  path: string,
  previous: FileSnapshot | undefined,
  publishedContents: string,
  published: boolean,
  label: "definition" | "receipt",
): Promise<void> {
  const boundary = serviceBoundary(plan, path);
  const current = await snapshot(path, boundary);
  if (optionalSnapshotsMatch(current, previous)) return;
  if (!published || current === undefined || !sameSnapshot(current, expectedPublishedSnapshot(publishedContents))) {
    throw new ServiceError(
      "permission-denied",
      `Service ${label} changed during install rollback: ${path}`,
      { path },
    );
  }
  if (previous === undefined) await removeFile(path, boundary, current);
  else await publishFile(path, previous.contents.toString("utf8"), boundary, current);
}

async function assertRollbackSnapshots(
  plan: ServicePlan,
  previousDefinition: FileSnapshot | undefined,
  previousReceipt: FileSnapshot | undefined,
  operation: "install" | "uninstall",
): Promise<void> {
  const [definition, receipt] = await Promise.all([
    snapshot(plan.definitionPath, serviceBoundary(plan, plan.definitionPath)),
    snapshot(plan.receiptPath, serviceBoundary(plan, plan.receiptPath)),
  ]);
  if (!optionalSnapshotsMatch(definition, previousDefinition)) {
    throw new ServiceError(
      "permission-denied",
      `Service definition does not match its pre-${operation} snapshot: ${plan.definitionPath}`,
      { path: plan.definitionPath },
    );
  }
  if (!optionalSnapshotsMatch(receipt, previousReceipt)) {
    throw new ServiceError(
      "permission-denied",
      `Service receipt does not match its pre-${operation} snapshot: ${plan.receiptPath}`,
      { path: plan.receiptPath },
    );
  }
}

async function restoreManagerAfterRollback(
  plan: ServicePlan,
  commandRunner: ServiceCommandRunner,
  before: ServiceManagerStatus,
  operation: "install" | "uninstall",
): Promise<void> {
  const executable = plan.installCommands[0]?.executable;
  if (executable === undefined) {
    throw new ServiceError("internal", `The ${plan.manager} rollback command plan is incomplete`);
  }
  if (plan.manager === "launchd") {
    const target = launchdServiceTarget(plan.uid, plan.serviceId);
    if (before.loaded) {
      if (before.enabled !== null) {
        await runRequired(commandRunner, exactCommand(executable, "enable", target), `Re-enabling ${plan.serviceId}`);
      }
      const bootstrap = plan.installCommands[1];
      if (bootstrap === undefined) {
        throw new ServiceError("internal", "The launchd rollback bootstrap command plan is incomplete");
      }
      await runActivationRequired(commandRunner, bootstrap, `Restoring ${plan.serviceId}`);
      if (before.active) {
        const kickstart = plan.installCommands[2];
        if (kickstart === undefined) {
          throw new ServiceError("internal", "The launchd rollback kickstart command plan is incomplete");
        }
        await runRequired(commandRunner, kickstart, `Restarting ${plan.serviceId} during ${operation} rollback`);
      }
      if (before.enabled === false) {
        await runRequired(commandRunner, exactCommand(executable, "disable", target), `Re-disabling ${plan.serviceId}`);
      }
    } else if (before.enabled === true) {
      await runRequired(commandRunner, exactCommand(executable, "enable", target), `Re-enabling ${plan.serviceId}`);
    } else if (before.enabled === false) {
      await runRequired(commandRunner, exactCommand(executable, "disable", target), `Re-disabling ${plan.serviceId}`);
    }
    return;
  }

  await runRequired(
    commandRunner,
    exactCommand(executable, "--user", "daemon-reload"),
    `Reloading the systemd user manager during ${operation} rollback`,
  );
  if (before.enabled === true) {
    await runRequired(
      commandRunner,
      exactCommand(executable, "--user", "enable", plan.serviceId),
      `Re-enabling ${plan.serviceId}`,
    );
  }
  if (before.active) {
    await runRequired(
      commandRunner,
      exactCommand(executable, "--user", "restart", plan.serviceId),
      `Restarting ${plan.serviceId} during ${operation} rollback`,
    );
  }
}

async function verifyRollbackManager(
  plan: ServicePlan,
  commandRunner: ServiceCommandRunner,
  before: ServiceManagerStatus,
  operation: "install" | "uninstall",
): Promise<void> {
  const after = await managerStatus(plan, commandRunner);
  if (!after.reachable) {
    throw new ServiceError(
      "internal",
      `The ${plan.manager} user manager became unavailable while verifying ${operation} rollback`,
      after.detail === undefined ? undefined : { detail: after.detail },
    );
  }
  const mismatches = rollbackManagerMismatches(after, before);
  if (mismatches.length > 0) {
    throw new ServiceError(
      "internal",
      `The ${plan.manager} manager did not return ${plan.serviceId} to its pre-${operation} state: ${mismatches.join(", ")}`,
    );
  }
}

function rollbackManagerMismatches(
  current: ServiceManagerStatus,
  expected: ServiceManagerStatus,
): string[] {
  const mismatches: string[] = [];
  if (current.loaded !== expected.loaded) mismatches.push(`loaded=${current.loaded} (expected ${expected.loaded})`);
  if (current.active !== expected.active) mismatches.push(`active=${current.active} (expected ${expected.active})`);
  if (expected.enabled !== null && current.enabled !== expected.enabled) {
    mismatches.push(`enabled=${String(current.enabled)} (expected ${expected.enabled})`);
  }
  return mismatches;
}

function installRollbackError(plan: ServicePlan, primary: unknown, rollback: unknown): ServiceError {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  const rollbackMessage = rollback instanceof Error ? rollback.message : String(rollback);
  const code = rollback instanceof ServiceError ? rollback.code : "internal";
  const options: { path?: string; detail: string } = {
    detail: `Install failure: ${primaryMessage}\nRollback failure: ${rollbackMessage}`,
  };
  if (rollback instanceof ServiceError && rollback.path !== undefined) options.path = rollback.path;
  return new ServiceError(
    code,
    `Installing ${plan.serviceId} failed (${primaryMessage}), and rollback did not complete safely: ${rollbackMessage}`,
    options,
  );
}

function serviceMutationIdentity(home: string): string {
  return join(absolutePath(home, "Home directory"), ".agents", ".git", "overlord", "service-lifecycle");
}

async function installServiceWithPlan(
  plan: ServicePlan,
  options: InstallServiceOptions,
): Promise<ServiceOperationResult> {
  const beforeInspection = await inspectDefinition(plan);
  const before = await inspectWithPlan(plan, options, options.dryRun !== true);
  if (before.state === "modified" || before.state === "collision") {
    throw new ServiceError("permission-denied", before.reason ?? "Refusing to replace an unowned service definition", {
      path: plan.definitionPath,
    });
  }

  const actions = [
    `${before.state === "absent" ? "Write" : before.state === "stale" ? "Update" : "Verify"} ${plan.definitionPath}`,
    `Enable and start ${plan.serviceId}`,
  ];
  if (options.dryRun === true) {
    return { plan, before, after: before, changed: false, dryRun: true, actions };
  }
  if (!before.manager.reachable) {
    throw new ServiceError(
      "internal",
      `The ${plan.manager} user manager is unavailable`,
      before.manager.detail === undefined ? undefined : { detail: before.manager.detail },
    );
  }
  await ensurePhysicalDirectory(dirname(plan.definitionPath), serviceBoundary(plan, plan.definitionPath));
  await ensurePhysicalDirectory(dirname(plan.receiptPath), serviceBoundary(plan, plan.receiptPath));
  if (before.state === "current" && before.healthy) {
    return { plan, before, after: before, changed: false, dryRun: false, actions: [] };
  }

  const commandRunner = runner(options);
  const previousDefinition = beforeInspection.definition;
  const previousReceipt = beforeInspection.receiptFile;
  const definitionChanged = before.state !== "current";
  let managerMutated = false;
  let managerOwned = false;
  let definitionPublished = false;
  let receiptPublished = false;
  try {
    if (plan.manager === "launchd" && before.manager.loaded) {
      const bootout = plan.uninstallCommands[0];
      if (bootout !== undefined) {
        await runRequired(commandRunner, bootout, `Stopping ${plan.serviceId} for update`);
        managerMutated = true;
        managerOwned = true;
        await waitForLaunchdBootout(plan, commandRunner);
      }
    }
    if (definitionChanged) {
      await publishFile(
        plan.definitionPath,
        plan.definition,
        serviceBoundary(plan, plan.definitionPath),
        previousDefinition,
      );
      definitionPublished = true;
      const nextReceipt = renderReceipt(receiptFor(plan));
      await publishFile(
        plan.receiptPath,
        nextReceipt,
        serviceBoundary(plan, plan.receiptPath),
        previousReceipt,
      );
      receiptPublished = true;
    }
    if (plan.stdoutLogPath !== undefined) {
      await ensurePhysicalDirectory(dirname(plan.stdoutLogPath), serviceBoundary(plan, plan.stdoutLogPath));
      await validateLaunchdLogPath(plan, plan.stdoutLogPath);
    }
    if (plan.stderrLogPath !== undefined) {
      await ensurePhysicalDirectory(dirname(plan.stderrLogPath), serviceBoundary(plan, plan.stderrLogPath));
      await validateLaunchdLogPath(plan, plan.stderrLogPath);
    }
    await activateService(plan, commandRunner, before.manager, (command) => {
      managerMutated = true;
      if (establishesManagerOwnership(plan, command)) managerOwned = true;
    });
  } catch (error) {
    try {
      await rollbackInstall(
        plan,
        commandRunner,
        previousDefinition,
        previousReceipt,
        before.manager,
        managerMutated,
        managerOwned,
        definitionPublished,
        receiptPublished,
      );
    } catch (rollbackError) {
      throw installRollbackError(plan, error, rollbackError);
    }
    throw error;
  }
  const after = await inspectWithPlan(plan, options);
  return { plan, before, after, changed: definitionChanged || !before.healthy, dryRun: false, actions };
}

/** Install or update the service definition and converge it to enabled and running. */
export async function installService(options: InstallServiceOptions): Promise<ServiceOperationResult> {
  const plan = await planService(options);
  if (options.dryRun === true) return installServiceWithPlan(plan, options);
  const release = await acquireScopeLock(serviceMutationIdentity(options.home));
  try {
    return await installServiceWithPlan(plan, options);
  } finally {
    await release();
  }
}

async function restoreRemovedSnapshot(
  plan: ServicePlan,
  path: string,
  previous: FileSnapshot | undefined,
  removed: boolean,
): Promise<void> {
  const boundary = serviceBoundary(plan, path);
  const current = await snapshot(path, boundary);
  if (optionalSnapshotsMatch(current, previous)) return;
  if (previous === undefined || current !== undefined || !removed) {
    throw new ServiceError(
      "permission-denied",
      `Service file changed during uninstall rollback: ${path}`,
      { path },
    );
  }
  await publishFile(path, previous.contents.toString("utf8"), boundary);
}

function uninstallRollbackError(plan: ServicePlan, primary: unknown, rollback: unknown): ServiceError {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  const rollbackMessage = rollback instanceof Error ? rollback.message : String(rollback);
  const code = rollback instanceof ServiceError ? rollback.code : "internal";
  const options: { path?: string; detail: string } = {
    detail: `Uninstall failure: ${primaryMessage}\nRollback failure: ${rollbackMessage}`,
  };
  if (rollback instanceof ServiceError && rollback.path !== undefined) options.path = rollback.path;
  return new ServiceError(
    code,
    `Uninstalling ${plan.serviceId} failed (${primaryMessage}), and rollback did not complete safely: ${rollbackMessage}`,
    options,
  );
}

async function uninstallServiceWithPlan(
  plan: ServicePlan,
  options: ServiceOptions,
): Promise<ServiceOperationResult> {
  const beforeInspection = await inspectDefinition(plan);
  const before = await inspectWithPlan(plan, options);
  if (before.state === "modified" || before.state === "collision") {
    throw new ServiceError("permission-denied", before.reason ?? "Refusing to remove an unowned service definition", {
      path: plan.definitionPath,
    });
  }
  if (!before.manager.reachable) {
    throw new ServiceError(
      "internal",
      `The ${plan.manager} user manager is unavailable`,
      before.manager.detail === undefined ? undefined : { detail: before.manager.detail },
    );
  }
  if (before.state === "absent" && !before.manager.active && before.manager.enabled !== true) {
    return { plan, before, after: before, changed: false, dryRun: false, actions: [] };
  }

  const commandRunner = runner(options);
  let definitionRemoved = false;
  let receiptRemoved = false;
  let managerMutated = false;
  try {
    if (plan.manager === "launchd") {
      if (before.manager.loaded) {
        await stopService(plan, commandRunner);
        managerMutated = true;
        await waitForLaunchdBootout(plan, commandRunner);
      }
    } else {
      await stopService(plan, commandRunner);
      managerMutated = true;
    }
    await removeFile(
      plan.definitionPath,
      serviceBoundary(plan, plan.definitionPath),
      beforeInspection.definition,
    );
    definitionRemoved = beforeInspection.definition !== undefined;
    await removeFile(
      plan.receiptPath,
      serviceBoundary(plan, plan.receiptPath),
      beforeInspection.receiptFile,
    );
    receiptRemoved = beforeInspection.receiptFile !== undefined;
    if (plan.manager === "systemd") {
      const reload = plan.uninstallCommands[1];
      if (reload !== undefined) await runRequired(commandRunner, reload, "Reloading the systemd user manager");
      const executable = plan.installCommands[0]?.executable;
      if (executable !== undefined) {
        await runBestEffort(commandRunner, exactCommand(executable, "--user", "reset-failed", plan.serviceId));
      }
    } else {
      const disable = plan.uninstallCommands[1];
      if (disable !== undefined) await runRequired(commandRunner, disable, `Disabling ${plan.serviceId}`);
    }
  } catch (error) {
    try {
      const restorations = await Promise.allSettled([
        restoreRemovedSnapshot(plan, plan.definitionPath, beforeInspection.definition, definitionRemoved),
        restoreRemovedSnapshot(plan, plan.receiptPath, beforeInspection.receiptFile, receiptRemoved),
      ]);
      const failedRestoration = restorations.find((result) => result.status === "rejected");
      if (failedRestoration?.status === "rejected") throw failedRestoration.reason;
      await assertRollbackSnapshots(
        plan,
        beforeInspection.definition,
        beforeInspection.receiptFile,
        "uninstall",
      );
      if (managerMutated) {
        const currentManager = await managerStatus(plan, commandRunner);
        if (!currentManager.reachable || rollbackManagerMismatches(currentManager, before.manager).length > 0) {
          await restoreManagerAfterRollback(plan, commandRunner, before.manager, "uninstall");
        }
      }
      await verifyRollbackManager(plan, commandRunner, before.manager, "uninstall");
    } catch (rollbackError) {
      throw uninstallRollbackError(plan, error, rollbackError);
    }
    throw error;
  }
  const after = await inspectWithPlan(plan, options);
  return {
    plan,
    before,
    after,
    changed: true,
    dryRun: false,
    actions: [
      `Stop and disable ${plan.serviceId}`,
      `Remove ${plan.definitionPath}`,
      `Remove ${plan.receiptPath}`,
    ],
  };
}

/** Stop and remove only a definition whose ownership receipt still matches it. */
export async function uninstallService(options: ServiceOptions): Promise<ServiceOperationResult> {
  const plan = await planService(options);
  const release = await acquireScopeLock(serviceMutationIdentity(options.home));
  try {
    return await uninstallServiceWithPlan(plan, options);
  } finally {
    await release();
  }
}

async function tailFile(plan: ServicePlan, path: string, maximumBytes: number): Promise<string> {
  await assertPhysicalFileParents(path, serviceBoundary(plan, path));
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new ServiceError("permission-denied", `Service log must be a physical readable file: ${path}`, {
      path,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const current = await handle.stat();
    if (!current.isFile()) {
      throw new ServiceError("permission-denied", `Service log must be a physical file: ${path}`, { path });
    }
    const size = Number(current.size);
    const length = Math.min(size, maximumBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Read a bounded recent log view without following the service. */
export async function readServiceLogs(
  options: ServiceOptions,
  limits?: { maximumBytes?: number; maximumLines?: number },
): Promise<ServiceLogs> {
  const plan = await planService(options);
  if (plan.manager === "launchd") {
    const maximumBytes = Math.max(1, Math.min(limits?.maximumBytes ?? DEFAULT_LOG_BYTES, 1024 * 1024));
    const [stdout, stderr] = await Promise.all([
      plan.stdoutLogPath === undefined ? "" : tailFile(plan, plan.stdoutLogPath, maximumBytes),
      plan.stderrLogPath === undefined ? "" : tailFile(plan, plan.stderrLogPath, maximumBytes),
    ]);
    return { plan, stdout, stderr };
  }

  const maximumLines = Math.max(1, Math.min(limits?.maximumLines ?? DEFAULT_LOG_LINES, 1000));
  const command = plan.logsCommand;
  if (command === undefined) throw new ServiceError("internal", "systemd log command plan is incomplete");
  const configured = {
    ...command,
    arguments: command.arguments.map((entry) => (
      entry.startsWith("--lines=") ? `--lines=${maximumLines}` : entry
    )),
  };
  const result = await runRequired(runner(options), configured, `Reading logs for ${plan.serviceId}`);
  return { plan, stdout: result.stdout, stderr: result.stderr };
}
