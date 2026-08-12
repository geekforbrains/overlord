import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ServiceError,
  inspectService,
  installService,
  planService,
  readServiceLogs,
  uninstallService,
  type ServiceCommandResult,
  type ServiceCommandRunner,
  type ServiceOptions,
  type ServicePlatform,
} from "../src/service.js";
import { LAUNCHD_SERVICE_ID } from "../src/service-launchd.js";
import { SYSTEMD_SERVICE_ID } from "../src/service-systemd.js";
import { cleanupTemporaryDirectories, temporaryDirectory, writeText } from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

interface RecordedCommand {
  executable: string;
  arguments: string[];
}

class FakeManager implements ServiceCommandRunner {
  readonly commands: RecordedCommand[] = [];
  loaded = false;
  enabled = false;
  reachable = true;
  failNextActivation = false;
  failNextKickstart = false;
  failNextBootout = false;
  failNextEnable = false;
  failNextDisable = false;
  failNextDaemonReload = false;
  failNextSystemdEnable = false;
  foreignJobOnBootstrapFailure = false;
  transientBootstrapFailures = 0;
  launchdBootoutStatusLag = 0;
  private pendingLaunchdBootoutChecks = 0;
  launchdBootoutStatusGate?: Promise<void>;
  onLaunchdBootoutStatus?: () => void;
  bootstrapGate?: Promise<void>;
  onBootstrap?: () => void;
  journal = "recent journal entry\n";

  async run(executable: string, arguments_: readonly string[]): Promise<ServiceCommandResult> {
    const args = [...arguments_];
    this.commands.push({ executable, arguments: args });
    if (executable.endsWith("launchctl") && args[0] === "bootstrap") {
      this.onBootstrap?.();
      if (this.bootstrapGate !== undefined) await this.bootstrapGate;
    }
    if (
      executable.endsWith("launchctl")
      && args[0] === "print"
      && args[1]?.split("/").length === 3
      && this.pendingLaunchdBootoutChecks > 0
    ) {
      this.onLaunchdBootoutStatus?.();
      if (this.launchdBootoutStatusGate !== undefined) await this.launchdBootoutStatusGate;
    }
    if (executable.endsWith("launchctl")) return this.launchd(args);
    if (executable.endsWith("systemctl")) return this.systemd(args);
    if (executable.endsWith("journalctl")) {
      return { exitCode: 0, stdout: this.journal, stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: `unexpected executable ${executable}` };
  }

  private launchd(args: string[]): ServiceCommandResult {
    if (args[0] === "print" && args[1]?.split("/").length === 2) {
      return this.reachable ? ok() : failed("launchd domain unavailable");
    }
    if (args[0] === "print") {
      const result = this.loaded ? ok("state = running\n") : failed("service not found");
      if (this.pendingLaunchdBootoutChecks > 0) {
        this.pendingLaunchdBootoutChecks -= 1;
        if (this.pendingLaunchdBootoutChecks === 0) this.loaded = false;
      }
      return result;
    }
    if (args[0] === "print-disabled") {
      return ok(`disabled services = {\n  "${LAUNCHD_SERVICE_ID}" => ${this.enabled ? "enabled" : "disabled"}\n}\n`);
    }
    if (args[0] === "bootout") {
      if (this.failNextBootout) {
        this.failNextBootout = false;
        return failed("bootout failed");
      }
      if (this.launchdBootoutStatusLag > 0) {
        this.pendingLaunchdBootoutChecks = this.launchdBootoutStatusLag;
      } else {
        this.loaded = false;
      }
      return ok();
    }
    if (args[0] === "enable") {
      if (this.failNextEnable) {
        this.failNextEnable = false;
        return failed("enable failed");
      }
      this.enabled = true;
      return ok();
    }
    if (args[0] === "disable") {
      if (this.failNextDisable) {
        this.failNextDisable = false;
        return failed("disable failed");
      }
      this.enabled = false;
      return ok();
    }
    if (args[0] === "bootstrap") {
      if (this.transientBootstrapFailures > 0) {
        this.transientBootstrapFailures -= 1;
        return failed("Bootstrap failed: 5: Input/output error");
      }
      if (this.failNextActivation) {
        this.failNextActivation = false;
        if (this.foreignJobOnBootstrapFailure) this.loaded = true;
        return failed("bootstrap failed");
      }
      this.loaded = true;
      return ok();
    }
    if (args[0] === "kickstart") {
      if (this.failNextKickstart) {
        this.failNextKickstart = false;
        return failed("kickstart failed");
      }
      this.loaded = true;
      return ok();
    }
    return failed(`unexpected launchctl arguments: ${args.join(" ")}`);
  }

  private systemd(args: string[]): ServiceCommandResult {
    const command = args[1];
    if (command === "show-environment") return this.reachable ? ok() : failed("user bus unavailable");
    if (command === "daemon-reload") {
      if (this.failNextDaemonReload) {
        this.failNextDaemonReload = false;
        return failed("daemon reload failed");
      }
      return ok();
    }
    if (command === "reset-failed") return ok();
    if (command === "is-active") return this.loaded ? ok("active\n") : failed("inactive", "inactive\n");
    if (command === "is-enabled") return this.enabled ? ok("enabled\n") : failed("disabled", "disabled\n");
    if (command === "show") return ok(this.loaded || this.enabled ? "loaded\n" : "not-found\n");
    if (command === "enable") {
      if (this.failNextSystemdEnable) {
        this.failNextSystemdEnable = false;
        return failed("systemd enable failed");
      }
      this.enabled = true;
      return ok();
    }
    if (command === "restart") {
      if (this.failNextActivation) {
        this.failNextActivation = false;
        return failed("restart failed");
      }
      this.loaded = true;
      return ok();
    }
    if (command === "disable" && args[2] === "--now") {
      this.loaded = false;
      this.enabled = false;
      return ok();
    }
    return failed(`unexpected systemctl arguments: ${args.join(" ")}`);
  }
}

function ok(stdout = ""): ServiceCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string, stdout = ""): ServiceCommandResult {
  return { exitCode: 1, stdout, stderr };
}

async function fixture(platform: ServicePlatform, manager = new FakeManager()) {
  const home = await temporaryDirectory();
  const nodePath = join(home, "runtime/node");
  const gitPath = join(home, "tools/git");
  const cliPath = join(home, "overlord/dist/cli.js");
  await writeText(nodePath, "node\n", 0o700);
  await writeText(gitPath, "git\n", 0o700);
  await chmod(nodePath, 0o700);
  await chmod(gitPath, 0o700);
  await writeText(cliPath, "cli\n", 0o600);
  const options: ServiceOptions = {
    home,
    env: {
      PATH: "/custom/bin:/usr/bin",
      CLAUDE_CONFIG_DIR: "claude-home",
      CODEX_HOME: join(home, "codex-home"),
      XDG_CONFIG_HOME: join(home, "xdg/config"),
      XDG_STATE_HOME: join(home, "xdg/state"),
    },
    platform,
    uid: 501,
    nodePath,
    gitPath,
    cliPath,
    version: "2.0.0-test",
    runner: manager,
  };
  return { home, nodePath, gitPath, cliPath, manager, options };
}

function mutatingCommands(manager: FakeManager): RecordedCommand[] {
  return manager.commands.filter(({ arguments: args }) => ![
    "print",
    "print-disabled",
    "show-environment",
    "show",
    "is-active",
    "is-enabled",
  ].includes(args[0] === "--user" ? args[1] ?? "" : args[0] ?? ""));
}

describe("service lifecycle", () => {
  it("installs, detects version drift, updates, remains idempotent, and safely uninstalls launchd", async () => {
    const fixture_ = await fixture("darwin");
    const first = await installService(fixture_.options);

    expect(first.before.state).toBe("absent");
    expect(first.after).toMatchObject({ state: "current", healthy: true, manager: { active: true } });
    expect(first.plan.serviceId).toBe(LAUNCHD_SERVICE_ID);
    expect(first.plan.environment).toMatchObject({
      HOME: fixture_.home,
      CLAUDE_CONFIG_DIR: join(fixture_.home, "claude-home"),
      CODEX_HOME: join(fixture_.home, "codex-home"),
      OVERLORD_SERVICE: "launchd",
      OVERLORD_SERVICE_VERSION: "2.0.0-test",
    });
    expect(first.plan.gitExecutable).toBe(await realpath(fixture_.gitPath));
    expect(first.plan.environment.PATH).toBe([
      dirname(first.plan.executable),
      dirname(first.plan.gitExecutable),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"));
    expect((await lstat(first.plan.definitionPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(first.plan.receiptPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(first.plan.definitionPath, "utf8")).toBe(first.plan.definition);
    expect(fixture_.manager.commands).toEqual(expect.arrayContaining([
      { executable: "/bin/launchctl", arguments: ["enable", `gui/501/${LAUNCHD_SERVICE_ID}`] },
      { executable: "/bin/launchctl", arguments: ["bootstrap", "gui/501", first.plan.definitionPath] },
      { executable: "/bin/launchctl", arguments: ["kickstart", `gui/501/${LAUNCHD_SERVICE_ID}`] },
    ]));

    const mutationCount = mutatingCommands(fixture_.manager).length;
    const repeated = await installService(fixture_.options);
    expect(repeated.changed).toBe(false);
    expect(mutatingCommands(fixture_.manager)).toHaveLength(mutationCount);

    const upgraded = await installService({ ...fixture_.options, version: "2.0.1-test" });
    expect(upgraded.before.state).toBe("stale");
    expect(upgraded.after).toMatchObject({ state: "current", healthy: true });
    expect(upgraded.plan.definition).toContain("2.0.1-test");
    expect(fixture_.manager.commands).toContainEqual({
      executable: "/bin/launchctl",
      arguments: ["bootout", `gui/501/${LAUNCHD_SERVICE_ID}`],
    });

    const removed = await uninstallService({ ...fixture_.options, version: "2.0.1-test" });
    expect(removed.after).toMatchObject({ state: "absent", healthy: false });
    expect(fixture_.manager.loaded).toBe(false);
    await expect(lstat(removed.plan.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(removed.plan.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });

    const repeatedRemoval = await uninstallService({ ...fixture_.options, version: "2.0.1-test" });
    expect(repeatedRemoval.changed).toBe(false);
  });

  it("classifies a coherent legacy receipt as stale and upgrades it explicitly", async () => {
    const fixture_ = await fixture("darwin");
    const installed = await installService(fixture_.options);
    const legacyDefinition = installed.plan.definition.replace(
      "<key>ExitTimeOut</key>\n  <integer>60</integer>",
      "<key>ExitTimeOut</key>\n  <integer>120</integer>",
    );
    const legacyReceipt = JSON.parse(await readFile(installed.plan.receiptPath, "utf8")) as Record<string, unknown>;
    legacyReceipt.formatVersion = 1;
    legacyReceipt.definitionDigest = createHash("sha256").update(legacyDefinition).digest("hex");
    await writeFile(installed.plan.definitionPath, legacyDefinition);
    await writeFile(installed.plan.receiptPath, `${JSON.stringify(legacyReceipt, null, 2)}\n`);

    await expect(inspectService(fixture_.options)).resolves.toMatchObject({ state: "stale", healthy: false });
    const upgraded = await installService(fixture_.options);
    expect(upgraded.after).toMatchObject({ state: "current", healthy: true });
    expect(JSON.parse(await readFile(upgraded.plan.receiptPath, "utf8"))).toMatchObject({ formatVersion: 2 });
  });

  it("retries the transient launchd bootstrap race during an owned update", async () => {
    const manager = new FakeManager();
    const fixture_ = await fixture("darwin", manager);
    await installService(fixture_.options);
    manager.transientBootstrapFailures = 1;

    const upgraded = await installService({ ...fixture_.options, version: "2.0.1-test" });

    expect(upgraded.after).toMatchObject({ state: "current", healthy: true });
    expect(manager.commands.filter(({ arguments: args }) => args[0] === "bootstrap")).toHaveLength(3);
  });

  it("keeps ownership files until an asynchronous launchd bootout settles", async () => {
    const manager = new FakeManager();
    const fixture_ = await fixture("darwin", manager);
    const installed = await installService(fixture_.options);
    let releaseBootoutStatus: (() => void) | undefined;
    let notifyBootoutStatus: (() => void) | undefined;
    manager.launchdBootoutStatusLag = 1;
    manager.launchdBootoutStatusGate = new Promise<void>((resolvePromise) => {
      releaseBootoutStatus = resolvePromise;
    });
    const bootoutStatusStarted = new Promise<void>((resolvePromise) => {
      notifyBootoutStatus = resolvePromise;
    });
    manager.onLaunchdBootoutStatus = () => notifyBootoutStatus?.();

    const removal = uninstallService(fixture_.options);
    await bootoutStatusStarted;
    await expect(readFile(installed.plan.definitionPath, "utf8")).resolves.toBe(installed.plan.definition);
    await expect(readFile(installed.plan.receiptPath, "utf8")).resolves.toContain('"formatVersion": 2');
    releaseBootoutStatus?.();

    const removed = await removal;
    expect(removed.after).toMatchObject({ state: "absent", manager: { loaded: false } });
    await expect(lstat(installed.plan.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(installed.plan.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves ownership when launchd bootout does not settle before its bound", async () => {
    vi.useFakeTimers();
    try {
      const manager = new FakeManager();
      const fixture_ = await fixture("darwin", manager);
      const installed = await installService(fixture_.options);
      manager.launchdBootoutStatusLag = 100;
      let notifyBootoutStatus: (() => void) | undefined;
      const bootoutStatusStarted = new Promise<void>((resolvePromise) => {
        notifyBootoutStatus = resolvePromise;
      });
      manager.onLaunchdBootoutStatus = () => notifyBootoutStatus?.();

      const removal = uninstallService(fixture_.options).catch((error: unknown) => error);
      await bootoutStatusStarted;
      await vi.runAllTimersAsync();
      const error = await removal;

      expect(error).toMatchObject({
        code: "internal",
        message: expect.stringContaining("did not settle in launchd"),
      });
      await expect(readFile(installed.plan.definitionPath, "utf8")).resolves.toBe(installed.plan.definition);
      await expect(readFile(installed.plan.receiptPath, "utf8")).resolves.toContain('"formatVersion": 2');
      await expect(inspectService(fixture_.options)).resolves.toMatchObject({
        state: "current",
        healthy: true,
        manager: { loaded: true, active: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps newly published files until delayed launchd install rollback settles", async () => {
    const manager = new FakeManager();
    manager.failNextKickstart = true;
    manager.launchdBootoutStatusLag = 1;
    let releaseBootoutStatus: (() => void) | undefined;
    let notifyBootoutStatus: (() => void) | undefined;
    manager.launchdBootoutStatusGate = new Promise<void>((resolvePromise) => {
      releaseBootoutStatus = resolvePromise;
    });
    const bootoutStatusStarted = new Promise<void>((resolvePromise) => {
      notifyBootoutStatus = resolvePromise;
    });
    manager.onLaunchdBootoutStatus = () => notifyBootoutStatus?.();
    const fixture_ = await fixture("darwin", manager);
    const plan = await planService(fixture_.options);

    const installation = installService(fixture_.options).catch((error: unknown) => error);
    await bootoutStatusStarted;
    await expect(readFile(plan.definitionPath, "utf8")).resolves.toBe(plan.definition);
    await expect(readFile(plan.receiptPath, "utf8")).resolves.toContain('"formatVersion": 2');
    releaseBootoutStatus?.();

    const error = await installation;
    expect(error).toMatchObject({
      code: "internal",
      message: expect.stringContaining("kickstart failed"),
    });
    await expect(lstat(plan.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(plan.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.loaded).toBe(false);
    expect(manager.enabled).toBe(false);
  });

  it("preserves published ownership when launchd install rollback cannot settle", async () => {
    vi.useFakeTimers();
    try {
      const manager = new FakeManager();
      manager.failNextKickstart = true;
      manager.launchdBootoutStatusLag = 100;
      let notifyBootoutStatus: (() => void) | undefined;
      const bootoutStatusStarted = new Promise<void>((resolvePromise) => {
        notifyBootoutStatus = resolvePromise;
      });
      manager.onLaunchdBootoutStatus = () => notifyBootoutStatus?.();
      const fixture_ = await fixture("darwin", manager);
      const plan = await planService(fixture_.options);

      const installation = installService(fixture_.options).catch((error: unknown) => error);
      await bootoutStatusStarted;
      await vi.runAllTimersAsync();
      const error = await installation;

      expect(error).toMatchObject({
        code: "internal",
        message: expect.stringContaining("rollback did not complete safely"),
        detail: expect.stringMatching(/kickstart failed[\s\S]*did not settle in launchd/u),
      });
      await expect(readFile(plan.definitionPath, "utf8")).resolves.toBe(plan.definition);
      await expect(readFile(plan.receiptPath, "utf8")).resolves.toContain('"formatVersion": 2');
      expect(manager.loaded).toBe(true);
      expect(manager.enabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a launchd install rollback bootout failure without replacing ownership files", async () => {
    const manager = new FakeManager();
    manager.failNextKickstart = true;
    manager.failNextBootout = true;
    const fixture_ = await fixture("darwin", manager);
    const plan = await planService(fixture_.options);

    await expect(installService(fixture_.options)).rejects.toMatchObject({
      code: "internal",
      message: expect.stringMatching(/kickstart failed[\s\S]*rollback did not complete safely[\s\S]*bootout failed/u),
    });
    await expect(readFile(plan.definitionPath, "utf8")).resolves.toBe(plan.definition);
    await expect(readFile(plan.receiptPath, "utf8")).resolves.toContain('"formatVersion": 2');
    expect(manager.loaded).toBe(true);
    expect(manager.enabled).toBe(true);
  });

  it.each(["definition", "receipt"] as const)(
    "does not reactivate launchd after an external %s mutation wins the publication CAS",
    async (artifact) => {
      const manager = new FakeManager();
      const fixture_ = await fixture("darwin", manager);
      const installed = await installService(fixture_.options);
      const previousDefinition = await readFile(installed.plan.definitionPath, "utf8");
      const previousReceipt = await readFile(installed.plan.receiptPath, "utf8");
      const bootstrapCount = manager.commands.filter(({ arguments: args }) => args[0] === "bootstrap").length;
      let releaseBootoutStatus: (() => void) | undefined;
      let notifyBootoutStatus: (() => void) | undefined;
      manager.launchdBootoutStatusLag = 1;
      manager.launchdBootoutStatusGate = new Promise<void>((resolvePromise) => {
        releaseBootoutStatus = resolvePromise;
      });
      const bootoutStatusStarted = new Promise<void>((resolvePromise) => {
        notifyBootoutStatus = resolvePromise;
      });
      manager.onLaunchdBootoutStatus = () => notifyBootoutStatus?.();
      const updatedOptions = { ...fixture_.options, version: "2.0.1-test" };
      const updatedPlan = await planService(updatedOptions);

      const installation = installService(updatedOptions).catch((error: unknown) => error);
      await bootoutStatusStarted;
      const mutatedPath = artifact === "definition" ? updatedPlan.definitionPath : updatedPlan.receiptPath;
      await writeFile(mutatedPath, `external ${artifact} mutation\n`);
      releaseBootoutStatus?.();
      const error = await installation;

      expect(error).toMatchObject({
        code: "permission-denied",
        message: expect.stringMatching(new RegExp(`${artifact} changed during install rollback`, "u")),
      });
      expect(manager.commands.filter(({ arguments: args }) => args[0] === "bootstrap")).toHaveLength(bootstrapCount);
      expect(manager.loaded).toBe(false);
      expect(await readFile(updatedPlan.definitionPath, "utf8")).toBe(
        artifact === "definition" ? "external definition mutation\n" : previousDefinition,
      );
      expect(await readFile(updatedPlan.receiptPath, "utf8")).toBe(
        artifact === "receipt" ? "external receipt mutation\n" : previousReceipt,
      );
    },
  );

  it.each([
    {
      command: "bootstrap",
      prepare(manager: FakeManager): void {
        manager.failNextActivation = true;
      },
      expectedFailure: "bootstrap failed",
    },
    {
      command: "kickstart",
      prepare(manager: FakeManager): void {
        manager.failNextKickstart = true;
      },
      expectedFailure: "kickstart failed",
    },
    {
      command: "enable",
      beforeInstall(manager: FakeManager): void {
        manager.enabled = false;
      },
      prepare(manager: FakeManager): void {
        manager.failNextEnable = true;
      },
      expectedFailure: "enable failed",
    },
  ])("surfaces a required launchd $command failure while restoring a prior install", async ({
    beforeInstall,
    prepare,
    expectedFailure,
  }) => {
    const manager = new FakeManager();
    const fixture_ = await fixture("darwin", manager);
    const installed = await installService(fixture_.options);
    const previousDefinition = await readFile(installed.plan.definitionPath, "utf8");
    const previousReceipt = await readFile(installed.plan.receiptPath, "utf8");
    beforeInstall?.(manager);
    let releaseBootoutStatus: (() => void) | undefined;
    let notifyBootoutStatus: (() => void) | undefined;
    manager.launchdBootoutStatusLag = 1;
    manager.launchdBootoutStatusGate = new Promise<void>((resolvePromise) => {
      releaseBootoutStatus = resolvePromise;
    });
    const bootoutStatusStarted = new Promise<void>((resolvePromise) => {
      notifyBootoutStatus = resolvePromise;
    });
    manager.onLaunchdBootoutStatus = () => notifyBootoutStatus?.();
    const updatedOptions = { ...fixture_.options, version: "2.0.1-test" };
    const updatedPlan = await planService(updatedOptions);

    const installation = installService(updatedOptions).catch((error: unknown) => error);
    await bootoutStatusStarted;
    const outsideLog = join(fixture_.home, `outside-${expectedFailure.replace(" ", "-")}`);
    await writeFile(outsideLog, "outside\n");
    await symlink(outsideLog, updatedPlan.stdoutLogPath ?? "");
    prepare(manager);
    releaseBootoutStatus?.();
    const error = await installation;

    expect(error).toMatchObject({
      code: "internal",
      message: expect.stringMatching(new RegExp(`rollback did not complete safely[\\s\\S]*${expectedFailure}`, "u")),
    });
    await expect(readFile(updatedPlan.definitionPath, "utf8")).resolves.toBe(previousDefinition);
    await expect(readFile(updatedPlan.receiptPath, "utf8")).resolves.toBe(previousReceipt);
  });

  it("renders a dry-run without files or mutating manager calls", async () => {
    const fixture_ = await fixture("linux");
    const result = await installService({ ...fixture_.options, dryRun: true });

    expect(result).toMatchObject({ dryRun: true, changed: false, before: { state: "absent" } });
    expect(result.plan.serviceId).toBe(SYSTEMD_SERVICE_ID);
    expect(result.plan.environment.OVERLORD_SERVICE).toBe("systemd");
    expect(fixture_.manager.commands).toEqual([]);
    await expect(lstat(result.plan.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(result.plan.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses exact systemd user commands and bounded journal reads", async () => {
    const fixture_ = await fixture("linux");
    const installed = await installService(fixture_.options);

    expect(installed.after).toMatchObject({ state: "current", healthy: true, manager: { enabled: true } });
    expect(fixture_.manager.commands).toEqual(expect.arrayContaining([
      { executable: "/usr/bin/systemctl", arguments: ["--user", "daemon-reload"] },
      { executable: "/usr/bin/systemctl", arguments: ["--user", "enable", SYSTEMD_SERVICE_ID] },
      { executable: "/usr/bin/systemctl", arguments: ["--user", "restart", SYSTEMD_SERVICE_ID] },
    ]));

    const logs = await readServiceLogs(fixture_.options, { maximumLines: 37 });
    expect(logs.stdout).toBe(fixture_.manager.journal);
    expect(fixture_.manager.commands.at(-1)).toEqual({
      executable: "/usr/bin/journalctl",
      arguments: [
        "--user",
        `--unit=${SYSTEMD_SERVICE_ID}`,
        "--no-pager",
        "--lines=37",
        "--output=short-iso",
      ],
    });

    await uninstallService(fixture_.options);
    expect(fixture_.manager.commands).toEqual(expect.arrayContaining([
      { executable: "/usr/bin/systemctl", arguments: ["--user", "disable", "--now", SYSTEMD_SERVICE_ID] },
      { executable: "/usr/bin/systemctl", arguments: ["--user", "reset-failed", SYSTEMD_SERVICE_ID] },
    ]));
  });

  it("reads only the bounded tail of physical launchd logs", async () => {
    const fixture_ = await fixture("darwin");
    const plan = await planService(fixture_.options);
    expect(plan.stdoutLogPath).toBeDefined();
    expect(plan.stderrLogPath).toBeDefined();
    await writeText(plan.stdoutLogPath ?? "", "0123456789");
    await writeText(plan.stderrLogPath ?? "", "abcdefghij");

    await expect(readServiceLogs(fixture_.options, { maximumBytes: 4 })).resolves.toMatchObject({
      stdout: "6789",
      stderr: "ghij",
    });

    await writeFile(join(fixture_.home, "linked-log"), "outside\n");
    await unlink(plan.stdoutLogPath ?? "");
    await symlink(join(fixture_.home, "linked-log"), plan.stdoutLogPath ?? "");
    await expect(readServiceLogs(fixture_.options)).rejects.toMatchObject({
      code: "permission-denied",
      path: plan.stdoutLogPath,
    });
  });

  it("refuses to install launchd through a pre-existing symlinked log path", async () => {
    const fixture_ = await fixture("darwin");
    const plan = await planService(fixture_.options);
    await writeFile(join(fixture_.home, "outside-log"), "outside\n");
    await writeText(join(plan.stdoutLogPath ?? "", "..", ".keep"), "keep\n");
    await symlink(join(fixture_.home, "outside-log"), plan.stdoutLogPath ?? "");

    await expect(installService(fixture_.options)).rejects.toMatchObject({
      code: "permission-denied",
      path: plan.stdoutLogPath,
    });
    expect(fixture_.manager.loaded).toBe(false);
  });

  it("refuses tampered and symlinked definitions without manager mutation", async () => {
    const fixture_ = await fixture("linux");
    const installed = await installService(fixture_.options);
    await writeFile(installed.plan.definitionPath, "locally modified\n");
    const beforeCommands = mutatingCommands(fixture_.manager).length;

    await expect(installService(fixture_.options)).rejects.toMatchObject({
      code: "permission-denied",
      path: installed.plan.definitionPath,
    });
    await expect(uninstallService(fixture_.options)).rejects.toMatchObject({ code: "permission-denied" });
    expect(mutatingCommands(fixture_.manager)).toHaveLength(beforeCommands);

    const second = await fixture("darwin");
    const plan = await planService(second.options);
    await writeText(join(second.home, "target.plist"), "target\n");
    await writeText(join(plan.definitionPath, "..", ".keep"), "keep\n");
    await symlink(join(second.home, "target.plist"), plan.definitionPath);
    await expect(installService({ ...second.options, dryRun: true })).rejects.toMatchObject({
      code: "permission-denied",
      path: plan.definitionPath,
    });
  });

  it("rolls back fresh files after manager activation fails", async () => {
    const manager = new FakeManager();
    manager.failNextActivation = true;
    const fixture_ = await fixture("linux", manager);
    const plan = await planService(fixture_.options);

    await expect(installService(fixture_.options)).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining("restart failed"),
    });
    await expect(lstat(plan.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(plan.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.loaded).toBe(false);
    expect(manager.enabled).toBe(false);
  });

  it("restores an enabled-but-inactive systemd unit after restart failure", async () => {
    const manager = new FakeManager();
    const fixture_ = await fixture("linux", manager);
    await installService(fixture_.options);
    manager.loaded = false;
    manager.enabled = true;
    manager.failNextActivation = true;

    await expect(installService(fixture_.options)).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining("restart failed"),
    });
    expect(manager.enabled).toBe(true);
    expect(manager.loaded).toBe(false);
    await expect(inspectService(fixture_.options)).resolves.toMatchObject({
      state: "current",
      healthy: false,
      manager: { enabled: true, active: false },
    });
  });

  it("restores explicit launchd disablement after bootstrap failure", async () => {
    const manager = new FakeManager();
    const fixture_ = await fixture("darwin", manager);
    await installService(fixture_.options);
    manager.loaded = false;
    manager.enabled = false;
    manager.failNextActivation = true;

    await expect(installService(fixture_.options)).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining("bootstrap failed"),
    });
    expect(manager.enabled).toBe(false);
    expect(manager.loaded).toBe(false);
    await expect(inspectService(fixture_.options)).resolves.toMatchObject({
      state: "current",
      healthy: false,
      manager: { enabled: false, active: false },
    });
  });

  it("does not bootout a foreign launchd job that appears during bootstrap", async () => {
    const manager = new FakeManager();
    manager.failNextActivation = true;
    manager.foreignJobOnBootstrapFailure = true;
    const fixture_ = await fixture("darwin", manager);
    const plan = await planService(fixture_.options);

    await expect(installService(fixture_.options)).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining("bootstrap failed"),
    });
    expect(manager.loaded).toBe(true);
    expect(manager.commands).not.toContainEqual({
      executable: "/bin/launchctl",
      arguments: ["bootout", `gui/501/${LAUNCHD_SERVICE_ID}`],
    });
    expect(manager.commands).not.toContainEqual({
      executable: "/bin/launchctl",
      arguments: ["disable", `gui/501/${LAUNCHD_SERVICE_ID}`],
    });
    await expect(lstat(plan.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(plan.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsupported platforms and root service management", async () => {
    const fixture_ = await fixture("linux");
    await expect(planService({ ...fixture_.options, platform: "win32" })).rejects.toBeInstanceOf(ServiceError);
    await expect(planService({ ...fixture_.options, uid: 0 })).rejects.toMatchObject({
      code: "permission-denied",
      message: expect.stringContaining("root"),
    });
  });

  it("reports owned active state for CLI lifecycle decisions", async () => {
    const fixture_ = await fixture("darwin");
    await installService(fixture_.options);

    await expect(inspectService(fixture_.options)).resolves.toMatchObject({
      state: "current",
      receipt: { serviceId: LAUNCHD_SERVICE_ID },
      manager: { reachable: true, loaded: true, active: true },
      healthy: true,
    });
  });

  it.each(["darwin", "linux"] as const)(
    "refuses an unowned %s manager-label collision for install and uninstall",
    async (platform) => {
      const manager = new FakeManager();
      manager.loaded = true;
      manager.enabled = platform === "linux";
      const fixture_ = await fixture(platform, manager);

      await expect(inspectService(fixture_.options)).resolves.toMatchObject({
        state: "collision",
        manager: { loaded: true },
        reason: expect.stringContaining("without an Overlord-owned definition"),
      });
      await expect(installService(fixture_.options)).rejects.toMatchObject({ code: "permission-denied" });
      await expect(uninstallService(fixture_.options)).rejects.toMatchObject({ code: "permission-denied" });
      expect(manager.loaded).toBe(true);
      expect(mutatingCommands(manager)).toEqual([]);
    },
  );

  it("reports an unreachable manager read-only and refuses to write an install", async () => {
    const manager = new FakeManager();
    manager.reachable = false;
    const fixture_ = await fixture("linux", manager);
    const status = await inspectService(fixture_.options);

    expect(status).toMatchObject({
      state: "absent",
      manager: { reachable: false, loaded: false, active: false, detail: "user bus unavailable" },
      healthy: false,
    });
    await expect(installService(fixture_.options)).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining("unavailable"),
    });
    await expect(lstat(status.plan.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(status.plan.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent service mutations without deleting the winner's files", async () => {
    const manager = new FakeManager();
    let releaseBootstrap: (() => void) | undefined;
    let notifyBootstrap: (() => void) | undefined;
    manager.bootstrapGate = new Promise<void>((resolvePromise) => { releaseBootstrap = resolvePromise; });
    const bootstrapStarted = new Promise<void>((resolvePromise) => { notifyBootstrap = resolvePromise; });
    manager.onBootstrap = () => notifyBootstrap?.();
    const fixture_ = await fixture("darwin", manager);

    const first = installService(fixture_.options);
    await bootstrapStarted;
    await expect(installService(fixture_.options)).rejects.toMatchObject({ code: "lock-held" });
    releaseBootstrap?.();
    const installed = await first;

    expect(await readFile(installed.plan.definitionPath, "utf8")).toBe(installed.plan.definition);
    await expect(inspectService(fixture_.options)).resolves.toMatchObject({ state: "current", healthy: true });
  });

  it("rejects receipt-only and paired definition-and-receipt tampering", async () => {
    const first = await fixture("linux");
    const installed = await installService(first.options);
    const receipt = JSON.parse(await readFile(installed.plan.receiptPath, "utf8")) as Record<string, unknown>;
    receipt.executable = installed.plan.gitExecutable;
    await writeFile(installed.plan.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    await expect(inspectService(first.options)).resolves.toMatchObject({ state: "modified", healthy: false });
    await expect(installService(first.options)).rejects.toMatchObject({ code: "permission-denied" });
    await expect(uninstallService(first.options)).rejects.toMatchObject({ code: "permission-denied" });

    const second = await fixture("darwin");
    const paired = await installService(second.options);
    const foreignDefinition = paired.plan.definition.replace("</plist>", "<!-- foreign -->\n</plist>");
    const pairedReceipt = JSON.parse(await readFile(paired.plan.receiptPath, "utf8")) as Record<string, unknown>;
    pairedReceipt.definitionDigest = createHash("sha256").update(foreignDefinition).digest("hex");
    await writeFile(paired.plan.definitionPath, foreignDefinition);
    await writeFile(paired.plan.receiptPath, `${JSON.stringify(pairedReceipt, null, 2)}\n`);

    await expect(inspectService(second.options)).resolves.toMatchObject({ state: "modified", healthy: false });
    await expect(uninstallService(second.options)).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("treats unsafe service-file permissions as external modification", async () => {
    const fixture_ = await fixture("darwin");
    const installed = await installService(fixture_.options);
    await chmod(installed.plan.receiptPath, 0o666);

    await expect(inspectService(fixture_.options)).resolves.toMatchObject({
      state: "modified",
      reason: expect.stringContaining("mode 0600"),
      healthy: false,
    });
    await expect(uninstallService(fixture_.options)).rejects.toMatchObject({ code: "permission-denied" });
  });

  it.each([false, true])(
    "refuses a service path below a symlinked parent (existing descendant: %s)",
    async (existingDescendant) => {
      const fixture_ = await fixture("darwin");
      const outside = await temporaryDirectory();
      if (existingDescendant) await mkdir(join(outside, "LaunchAgents"), { recursive: true });
      await symlink(outside, join(fixture_.home, "Library"));

      await expect(installService({ ...fixture_.options, dryRun: true })).rejects.toMatchObject({
        code: "permission-denied",
        path: join(fixture_.home, "Library"),
      });
    },
  );

  it("reports an explicitly disabled launchd job as unhealthy and re-enables it", async () => {
    const fixture_ = await fixture("darwin");
    await installService(fixture_.options);
    fixture_.manager.enabled = false;

    await expect(inspectService(fixture_.options)).resolves.toMatchObject({
      state: "current",
      manager: { active: true, enabled: false },
      healthy: false,
    });
    await expect(installService(fixture_.options)).resolves.toMatchObject({
      changed: true,
      after: { state: "current", healthy: true, manager: { enabled: true } },
    });
  });

  it("restores files and manager state when uninstall fails after removal", async () => {
    const manager = new FakeManager();
    const fixture_ = await fixture("linux", manager);
    const installed = await installService(fixture_.options);
    manager.failNextDaemonReload = true;

    await expect(uninstallService(fixture_.options)).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining("daemon reload failed"),
    });
    expect(await readFile(installed.plan.definitionPath, "utf8")).toBe(installed.plan.definition);
    await expect(inspectService(fixture_.options)).resolves.toMatchObject({
      state: "current",
      healthy: true,
      manager: { active: true, enabled: true },
    });
  });

  it("restores launchd files and manager state when disable fails after removal", async () => {
    const manager = new FakeManager();
    const fixture_ = await fixture("darwin", manager);
    const installed = await installService(fixture_.options);
    manager.failNextDisable = true;

    await expect(uninstallService(fixture_.options)).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining("disable failed"),
    });
    await expect(readFile(installed.plan.definitionPath, "utf8")).resolves.toBe(installed.plan.definition);
    await expect(readFile(installed.plan.receiptPath, "utf8")).resolves.toContain('"formatVersion": 2');
    await expect(inspectService(fixture_.options)).resolves.toMatchObject({
      state: "current",
      healthy: true,
      manager: { loaded: true, active: true, enabled: true },
    });
  });

  it.each([
    {
      command: "bootstrap",
      prepare(manager: FakeManager): void {
        manager.failNextActivation = true;
      },
      expectedFailure: "bootstrap failed",
    },
    {
      command: "kickstart",
      prepare(manager: FakeManager): void {
        manager.failNextKickstart = true;
      },
      expectedFailure: "kickstart failed",
    },
  ])("combines launchd uninstall failure with rollback $command failure", async ({
    prepare,
    expectedFailure,
  }) => {
    const manager = new FakeManager();
    const fixture_ = await fixture("darwin", manager);
    const installed = await installService(fixture_.options);
    manager.failNextDisable = true;
    prepare(manager);

    await expect(uninstallService(fixture_.options)).rejects.toMatchObject({
      code: "internal",
      message: expect.stringMatching(
        new RegExp(`disable failed[\\s\\S]*rollback did not complete safely[\\s\\S]*${expectedFailure}`, "u"),
      ),
      detail: expect.stringMatching(new RegExp(`disable failed[\\s\\S]*${expectedFailure}`, "u")),
    });
    await expect(readFile(installed.plan.definitionPath, "utf8")).resolves.toBe(installed.plan.definition);
    await expect(readFile(installed.plan.receiptPath, "utf8")).resolves.toContain('"formatVersion": 2');
  });

  it("combines a systemd uninstall failure with required rollback enable failure", async () => {
    const manager = new FakeManager();
    const fixture_ = await fixture("linux", manager);
    const installed = await installService(fixture_.options);
    manager.failNextDaemonReload = true;
    manager.failNextSystemdEnable = true;

    await expect(uninstallService(fixture_.options)).rejects.toMatchObject({
      code: "internal",
      message: expect.stringMatching(
        /daemon reload failed[\s\S]*rollback did not complete safely[\s\S]*systemd enable failed/u,
      ),
      detail: expect.stringMatching(/daemon reload failed[\s\S]*systemd enable failed/u),
    });
    await expect(readFile(installed.plan.definitionPath, "utf8")).resolves.toBe(installed.plan.definition);
    await expect(readFile(installed.plan.receiptPath, "utf8")).resolves.toContain('"formatVersion": 2');
  });
});
