import { lstat, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import type { OutputDocument } from "../src/types.js";
import { cleanupTemporaryDirectories, prepareUserRepository, temporaryDirectory, validSkill, writeText } from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: (chunk: string) => { stderr += chunk; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function runtime(home: string) {
  return {
    home,
    env: {
      PATH: "",
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
    },
  };
}

let validateOutput: ValidateFunction | undefined;

async function parseSingleJson(stdout: string): Promise<Record<string, unknown>> {
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const document = JSON.parse(stdout) as Record<string, unknown>;
  if (validateOutput === undefined) {
    const schema = JSON.parse(await readFile(new URL("../docs/schemas/output.schema.json", import.meta.url), "utf8")) as object;
    validateOutput = new Ajv2020({ allErrors: true }).compile(schema);
  }
  const valid = validateOutput(document);
  if (!valid) throw new Error(JSON.stringify(validateOutput.errors));
  expect(valid).toBe(true);
  return document;
}

async function fleetFixture() {
  const home = await temporaryDirectory();
  const root = await temporaryDirectory();
  const project = join(root, "project");
  await writeText(
    join(home, ".agents/overlord/overlord.yaml"),
    `roots:\n  - ${JSON.stringify(root)}\n`,
  );
  await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
  await prepareUserRepository(home);
  return { home, project };
}

function withoutTiming(document: Record<string, unknown>): Record<string, unknown> {
  const { timing: _timing, ...stable } = document;
  return stable;
}

function emptyWatchDocument(home: string): OutputDocument {
  return {
    schemaVersion: 2,
    command: "sync",
    status: "ok",
    scopes: [{ type: "user", path: home, canonical: join(home, ".agents") }],
    definitions: [],
    summary: { total: 0, byState: {}, managed: 0 },
    actions: [],
    diagnostics: [],
  };
}

describe("CLI contract", () => {
  it.each(["init", "status", "check", "sync"])("accepts bare %s and optional JSON output", async (command) => {
    const home = await temporaryDirectory();
    const human = captureIo();
    const captured = captureIo();
    if (command !== "init") await prepareUserRepository(home);

    expect(await runCli([command], human.io, runtime(home))).toBe(0);
    expect(human.stdout()).toContain(`${command}: ok`);
    const code = await runCli([command, "--json"], captured.io, runtime(home));

    expect(code).toBe(0);
    expect(await parseSingleJson(captured.stdout())).toMatchObject({ command, status: "ok" });
    expect(captured.stderr()).not.toContain("Try 'overlord --help'");
  });

  it("fails status on an uninitialized home without creating a Git repository", async () => {
    const home = await temporaryDirectory();
    const captured = captureIo();

    const code = await runCli(["status", "--json"], captured.io, runtime(home));
    const document = await parseSingleJson(captured.stdout());

    expect(code).toBe(2);
    expect(document).toMatchObject({ status: "error", error: { code: "permission-denied" } });
    await expect(lstat(join(home, ".agents/.git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits schema-valid fixed commit metadata from init", async () => {
    const home = await temporaryDirectory();
    const captured = captureIo();

    const code = await runCli(["init", "--json"], captured.io, runtime(home));
    const document = await parseSingleJson(captured.stdout());

    expect(code).toBe(0);
    expect(document.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "completed",
        commit: expect.objectContaining({
          repository: join(home, ".agents"),
          message: "overlord: initialize",
          origins: [],
          files: expect.arrayContaining([
            join(home, ".agents/overlord/overlord.yaml"),
            join(home, ".agents/skills/overlord/SKILL.md"),
          ]),
        }),
      }),
    ]));
  });

  it("reports a physical but invalid Git directory as a permission error", async () => {
    const home = await temporaryDirectory();
    const captured = captureIo();
    await mkdir(join(home, ".agents/.git"), { recursive: true });

    const code = await runCli(["status", "--json"], captured.io, runtime(home));
    const document = await parseSingleJson(captured.stdout());

    expect(code).toBe(2);
    expect(document).toMatchObject({ status: "error", error: { code: "permission-denied" } });
  });

  it("reports the fleet as scopes and never emits the legacy singular scope or targets", async () => {
    const { home, project } = await fleetFixture();
    const captured = captureIo();

    const code = await runCli(["status", "--json"], captured.io, runtime(home));
    const document = await parseSingleJson(captured.stdout());

    expect(code).toBe(0);
    expect(document).not.toHaveProperty("scope");
    expect(document).not.toHaveProperty("targets");
    expect(document.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "user", path: home }),
      expect.objectContaining({ type: "project", path: project }),
    ]));
    expect(document.definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "skill", name: "verify-build", scope: "project", scopePath: project }),
    ]));
  });

  it("returns attention-required from check and success from status for the same fleet", async () => {
    const { home } = await fleetFixture();
    expect(await runCli(["status", "--json"], captureIo().io, runtime(home))).toBe(0);
    expect(await runCli(["check", "--json"], captureIo().io, runtime(home))).toBe(1);
  });

  it("returns the same fleet regardless of the working directory", async () => {
    const { home } = await fleetFixture();
    const firstCwd = await temporaryDirectory();
    const secondCwd = await temporaryDirectory();
    const firstCapture = captureIo();
    const secondCapture = captureIo();

    const originalCwd = process.cwd();
    try {
      process.chdir(firstCwd);
      expect(await runCli(["status", "--json"], firstCapture.io, runtime(home))).toBe(0);
      process.chdir(secondCwd);
      expect(await runCli(["status", "--json"], secondCapture.io, runtime(home))).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    const first = await parseSingleJson(firstCapture.stdout());
    const second = await parseSingleJson(secondCapture.stdout());
    expect(first.scopes).toEqual(second.scopes);
    expect(first.definitions).toEqual(second.definitions);
    expect(withoutTiming(first)).toEqual(withoutTiming(second));
  });

  it.each([
    ["--project", ["status", "--json", "--project", "/tmp/project"]],
    ["--project", ["status", "--json", "--project=/tmp/project"]],
    ["--global", ["status", "--json", "--global"]],
    ["--strict", ["status", "--json", "--strict"]],
    ["--resolve", ["sync", "--json", "--resolve", "skill:verify-build@user=skip"]],
    ["--dry-run", ["sync", "--json", "--dry-run"]],
    ["--unknown", ["status", "--json", "--unknown"]],
  ])("rejects removed or unknown option %s with one JSON usage error", async (option, argv) => {
    const home = await temporaryDirectory();
    const captured = captureIo();

    const code = await runCli(argv, captured.io, runtime(home));
    const document = await parseSingleJson(captured.stdout());

    expect(code).toBe(2);
    expect(document).toMatchObject({ status: "error", error: { code: "usage" } });
    expect(document).toHaveProperty("error.message", expect.stringContaining(option));
  });

  it("keeps removed options out of help", async () => {
    const captured = captureIo();

    expect(await runCli(["--help"], captured.io)).toBe(0);
    expect(captured.stdout()).toContain("--json");
    for (const option of ["--project", "--global", "--strict", "--resolve", "--dry-run"]) {
      expect(captured.stdout()).not.toContain(option);
    }
  });

  it("lists watch in top-level help", async () => {
    const captured = captureIo();

    expect(await runCli(["--help"], captured.io)).toBe(0);
    expect(captured.stdout()).toContain("watch     Keep the fleet synchronized until interrupted");
    expect(captured.stderr()).toBe("");
  });

  it("lists the service lifecycle and renders scoped help", async () => {
    const topLevel = captureIo();
    const service = captureIo();
    const install = captureIo();

    expect(await runCli(["--help"], topLevel.io)).toBe(0);
    expect(topLevel.stdout()).toContain("service   Install and manage the user auto-sync service");
    expect(await runCli(["service", "--help"], service.io)).toBe(0);
    expect(service.stdout()).toContain("install    Install, enable, and start");
    expect(service.stdout()).toContain("uninstall  Stop, disable, and remove");
    expect(await runCli(["service", "install", "--help"], install.io)).toBe(0);
    expect(install.stdout()).toBe("Usage: overlord service install [--dry-run]\n");
  });

  it("prints the exact generated service definition in an install dry-run", async () => {
    const home = await temporaryDirectory();
    const captured = captureIo();

    expect(await runCli(
      ["service", "install", "--dry-run"],
      captured.io,
      {
        ...runtime(home),
        service: {
          platform: "darwin",
          uid: 501,
          nodePath: process.execPath,
          cliPath: fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        },
      },
    )).toBe(0);
    expect(captured.stdout()).toContain("--- service definition ---\n");
    expect(captured.stdout()).toContain("<key>Label</key>\n  <string>io.github.geekforbrains.overlord.watch</string>");
    expect(captured.stdout()).toContain("--- end service definition ---\nservice install: dry-run\n");
    expect(captured.stderr()).toBe("");
  });

  it("rejects unsupported service arguments without extending fleet JSON", async () => {
    const unknown = captureIo();
    const json = captureIo();
    const misplacedDryRun = captureIo();

    expect(await runCli(["service", "restart"], unknown.io)).toBe(2);
    expect(unknown.stderr()).toContain("Unknown service command 'restart'");
    expect(await runCli(["service", "status", "--json"], json.io)).toBe(2);
    expect(json.stdout()).toBe("");
    expect(json.stderr()).toContain("--json is not supported by service commands");
    expect(await runCli(["status", "--dry-run"], misplacedDryRun.io)).toBe(2);
    expect(misplacedDryRun.stderr()).toContain("--dry-run is supported only by 'service install'");
  });

  it("formats an asynchronously rejected service operation instead of leaking a promise rejection", async () => {
    const home = await temporaryDirectory();
    const captured = captureIo();

    await expect(runCli(
      ["service", "status"],
      captured.io,
      { ...runtime(home), service: { platform: "win32", uid: 501 } },
    )).resolves.toBe(2);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toContain("User services are supported only on macOS and Linux");
  });

  it("does not advertise JSON output in watch help", async () => {
    const captured = captureIo();

    expect(await runCli(["watch", "--help"], captured.io)).toBe(0);
    expect(captured.stdout()).toBe("Usage: overlord watch\n");
    expect(captured.stdout()).not.toContain("--json");
    expect(captured.stderr()).toBe("");
  });

  it("rejects watch JSON output as a human usage error", async () => {
    const captured = captureIo();

    expect(await runCli(["watch", "--json"], captured.io)).toBe(2);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toContain("overlord: --json is not supported by watch");
    expect(captured.stderr()).toContain("Try 'overlord --help' for usage.");
  });

  it("exits an already-aborted watch without starting or hanging", async () => {
    const home = await temporaryDirectory();
    const controller = new AbortController();
    const captured = captureIo();
    controller.abort();

    const code = await runCli(
      ["watch"],
      captured.io,
      { ...runtime(home), signal: controller.signal },
    );

    expect(code).toBe(0);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toBe("");
  });

  it("prints lifecycle output and closes injected watchers on abort", async () => {
    const home = await temporaryDirectory();
    const controller = new AbortController();
    const captured = captureIo();
    let closed = 0;

    const running = runCli(
      ["watch"],
      captured.io,
      {
        ...runtime(home),
        signal: controller.signal,
        watch: {
          synchronize: async () => emptyWatchDocument(home),
          watchFactory: () => ({ close: () => { closed += 1; } }),
          scanIntervalMs: 0,
        },
      },
    );

    await expect.poll(captured.stdout).toContain("watch: started (initial sync): ok;");
    controller.abort();

    expect(await running).toBe(0);
    expect(captured.stdout()).toContain("watch: stopped\n");
    expect(captured.stderr()).toBe("");
    expect(closed).toBeGreaterThan(0);
  });

  it("allows only one watcher process per user fleet", async () => {
    const home = await temporaryDirectory();
    const firstController = new AbortController();
    const firstCapture = captureIo();
    const secondCapture = captureIo();
    const watch = {
      synchronize: async () => emptyWatchDocument(home),
      watchFactory: () => ({ close() {} }),
      scanIntervalMs: 0,
    };

    const first = runCli(
      ["watch"],
      firstCapture.io,
      { ...runtime(home), signal: firstController.signal, watch },
    );
    await expect.poll(firstCapture.stdout).toContain("watch: started (initial sync): ok;");

    expect(await runCli(["watch"], secondCapture.io, { ...runtime(home), watch })).toBe(2);
    expect(secondCapture.stderr()).toContain("Another Overlord mutation holds the scope lock");

    firstController.abort();
    expect(await first).toBe(0);
  });

  it("prints the installed version", async () => {
    const captured = captureIo();

    expect(await runCli(["--version"], captured.io)).toBe(0);
    expect(captured.stdout()).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("rejects planned actions in an error JSON document", async () => {
    const schema = JSON.parse(await readFile(new URL("../docs/schemas/output.schema.json", import.meta.url), "utf8")) as object;
    const validate = new Ajv2020({ allErrors: true }).compile(schema);

    const valid = validate({
      schemaVersion: 2,
      command: "init",
      status: "error",
      error: { code: "internal", message: "failed" },
      actions: [{
        id: "planned@/tmp/home",
        status: "planned",
        description: "Not completed.",
        scope: "user",
        scopePath: "/tmp/home",
      }],
    });

    expect(valid).toBe(false);
  });

  it("prints completed commit metadata when init fails after committing", async () => {
    const home = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const captured = captureIo();
    await prepareUserRepository(home);
    await symlink(outside, join(home, ".agents/.git/overlord"));

    const code = await runCli(["init"], captured.io, runtime(home));

    expect(code).toBe(2);
    expect(captured.stderr()).toMatch(/commit: [0-9a-f]{40,64} overlord: initialize/);
    expect(captured.stderr()).toContain(`file: ${join(home, ".agents/overlord/overlord.yaml")}`);
    expect(captured.stderr()).toContain(`file: ${join(home, ".agents/skills/overlord/SKILL.md")}`);
  });

  it("rejects an invalid fleet configuration before init mutates user files", async () => {
    const home = await temporaryDirectory();
    const captured = captureIo();
    await writeText(join(home, ".agents/overlord/overlord.yaml"), "roots: []\nproject: /tmp/example\n");

    const code = await runCli(["init", "--json"], captured.io, runtime(home));
    const document = await parseSingleJson(captured.stdout());

    expect(code).toBe(2);
    expect(document).toMatchObject({ status: "error", error: { code: "config-invalid" } });
    expect(document).not.toHaveProperty("actions");
    await expect(lstat(join(home, ".agents/.git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, ".agents/skills/overlord/SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
