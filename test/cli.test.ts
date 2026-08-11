import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { cleanupTemporaryDirectories, temporaryDirectory, validSkill, writeText } from "./helpers.js";

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
    `version: 2\nroots:\n  - ${JSON.stringify(root)}\n`,
  );
  await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
  return { home, project };
}

function withoutTiming(document: Record<string, unknown>): Record<string, unknown> {
  const { timing: _timing, ...stable } = document;
  return stable;
}

describe("CLI contract", () => {
  it.each(["init", "status", "check", "sync"])("accepts bare %s and optional JSON output", async (command) => {
    const home = await temporaryDirectory();
    const human = captureIo();
    const captured = captureIo();

    expect(await runCli([command], human.io, runtime(home))).toBe(0);
    expect(human.stdout()).toContain(`${command}: ok`);
    const code = await runCli([command, "--json"], captured.io, runtime(home));

    expect(code).toBe(0);
    expect(await parseSingleJson(captured.stdout())).toMatchObject({ command, status: "ok" });
    expect(captured.stderr()).not.toContain("Try 'overlord --help'");
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

  it("prints backup paths for successful human sync actions", async () => {
    const { home, project } = await fleetFixture();
    const captured = captureIo();
    await writeText(join(project, ".codex/skills/verify-build/SKILL.md"), validSkill);

    expect(await runCli(["sync"], captured.io, runtime(home))).toBe(0);

    const backupLine = captured.stdout().split("\n").find((line) => line.startsWith("  backup: "));
    expect(backupLine).toContain(join(project, ".codex/.overlord-backups"));
    expect(captured.stderr()).toBe("");
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

  it("rejects a legacy fleet configuration before init mutates user files", async () => {
    const home = await temporaryDirectory();
    const captured = captureIo();
    await writeText(join(home, ".agents/overlord/overlord.yaml"), "version: 1\nroots: []\n");

    const code = await runCli(["init", "--json"], captured.io, runtime(home));
    const document = await parseSingleJson(captured.stdout());

    expect(code).toBe(2);
    expect(document).toMatchObject({ status: "error", error: { code: "config-invalid" } });
    expect(document).not.toHaveProperty("actions");
    await expect(readFile(join(home, ".agents/skills/overlord/SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
