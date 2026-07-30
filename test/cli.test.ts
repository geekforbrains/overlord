import { afterEach, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { chmod, lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cleanupTemporaryDirectories, temporaryDirectory, validAgent, validSkill, writeText } from "./helpers.js";
import { runCli } from "../src/cli.js";

afterEach(cleanupTemporaryDirectories);

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: (chunk: string) => { stderr += chunk; },
      isTTY: false,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("CLI JSON contract", () => {
  it("emits exactly one schema-valid JSON document for status", async () => {
    const home = await temporaryDirectory();
    const project = join(home, "project");
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    const captured = captureIo();
    const code = await runCli(["status", "--json", "--project", project], captured.io, {
      cwd: project,
      home,
      env: { PATH: "" },
      availability: { claude: { available: false, version: null }, codex: { available: false, version: null } },
    });
    expect(code).toBe(0);
    const document = JSON.parse(captured.stdout());
    const schema = JSON.parse(await readFile(join(process.cwd(), "docs/schemas/output.schema.json"), "utf8"));
    const ajv = new Ajv2020({ allErrors: true });
    expect(ajv.validate(schema, document), JSON.stringify(ajv.errors)).toBe(true);
    expect(captured.stdout().trim().split("\n")).toHaveLength(1);
  });

  it("returns attention-required from check and success from status for the same inventory", async () => {
    const home = await temporaryDirectory();
    const project = join(home, "project");
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    const runtime = {
      cwd: project,
      home,
      env: {},
      availability: { claude: { available: true, version: "test" }, codex: { available: true, version: "test" } },
    } as const;
    expect(await runCli(["status", "--json", "--project", project], captureIo().io, runtime)).toBe(0);
    expect(await runCli(["check", "--json", "--project", project], captureIo().io, runtime)).toBe(1);
  });

  it("emits one JSON error document and exit 2 for usage errors", async () => {
    const home = await temporaryDirectory();
    const captured = captureIo();
    const code = await runCli(["status", "--json", "--global", "--project", home], captured.io, { cwd: home, home, env: {} });
    expect(code).toBe(2);
    expect(JSON.parse(captured.stdout())).toMatchObject({ status: "error", error: { code: "usage" } });
    expect(captured.stdout().trim().split("\n")).toHaveLength(1);
  });

  it("does not prompt in JSON mode and reports structured decisions", async () => {
    const home = await temporaryDirectory();
    const project = join(home, "project");
    await writeText(join(project, ".claude/agents/reviewer.md"), `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`);
    const captured = captureIo();
    await runCli(["sync", "--json", "--project", project], captured.io, {
      cwd: project,
      home,
      env: {},
      availability: { claude: { available: true, version: "test" }, codex: { available: false, version: null } },
    });
    const result = JSON.parse(captured.stdout());
    expect(result.definitions[0].decision).toMatchObject({ selector: `agent:reviewer@${project}`, options: ["adopt", "external", "delete", "skip"] });
    expect(result.actions).toContainEqual(expect.objectContaining({ requiresDecision: true, mutates: true, argv: expect.any(Array) }));
  });

  it("shows conflicting lines before an interactive prompt and defaults to skip", async () => {
    const home = await temporaryDirectory();
    const project = join(home, "project");
    const canonical = join(project, ".agents/skills/verify-build/SKILL.md");
    const native = join(project, ".claude/skills/verify-build/SKILL.md");
    const nativeSkill = validSkill.replace("Run the documented build", "Run the provider build");
    await writeText(canonical, validSkill);
    await writeText(native, nativeSkill);
    let stdout = "";
    let stderr = "";
    const prompts: string[] = [];
    const code = await runCli(["sync", "--project", project], {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: (chunk: string) => { stderr += chunk; },
      isTTY: true,
      prompt: async (question: string) => {
        prompts.push(question);
        return "";
      },
    }, {
      cwd: project,
      home,
      env: {},
      availability: { claude: { available: true, version: "test" }, codex: { available: false, version: null } },
    });

    expect(code).toBe(1);
    expect(stdout).toContain("- Run the documented build");
    expect(stdout).toContain("+ Run the provider build");
    expect(prompts).toHaveLength(1);
    expect(stderr).not.toContain("Choose one of");
    expect(await readFile(native, "utf8")).toBe(nativeSkill);
  });

  it("reports completed operations and backups when a later mutation fails", async () => {
    const home = await temporaryDirectory();
    const project = join(home, "project");
    const claude = join(project, ".claude/agents/reviewer.md");
    const codex = join(project, ".codex/agents/reviewer.toml");
    await writeText(claude, `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`);
    await writeText(codex, `name = "reviewer"\ndescription = "Reviews."\ndeveloper_instructions = "Review.\\n"\n`);
    await chmod(dirname(codex), 0o555);
    const captured = captureIo();
    let code: number;
    try {
      code = await runCli([
        "sync",
        "--json",
        "--project",
        project,
        "--resolve",
        "agent:reviewer@project=delete",
      ], captured.io, {
        cwd: project,
        home,
        env: {},
        availability: { claude: { available: true, version: "test" }, codex: { available: true, version: "test" } },
      });
    } finally {
      await chmod(dirname(codex), 0o755);
    }

    const document = JSON.parse(captured.stdout());
    expect(code!).toBe(2);
    expect(document).toMatchObject({ status: "error", error: { code: "permission-denied" } });
    expect(document.actions).toContainEqual(expect.objectContaining({
      removes: [claude],
      backups: [expect.any(String)],
    }));
    await expect(lstat(claude)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(codex, "utf8")).toContain('name = "reviewer"');

    const schema = JSON.parse(await readFile(join(process.cwd(), "docs/schemas/output.schema.json"), "utf8"));
    const ajv = new Ajv2020({ allErrors: true });
    expect(ajv.validate(schema, document), JSON.stringify(ajv.errors)).toBe(true);
  });

  it("journals a canonical adoption when removing the scan-only source fails", async () => {
    const home = await temporaryDirectory();
    const project = join(home, "project");
    const native = join(project, ".codex/skills/verify-build");
    const canonical = join(project, ".agents/skills/verify-build");
    await writeText(join(native, "SKILL.md"), validSkill);
    await chmod(dirname(native), 0o555);
    const captured = captureIo();
    let code: number;
    try {
      code = await runCli([
        "sync",
        "--json",
        "--project",
        project,
        "--resolve",
        "skill:verify-build@project=adopt",
      ], captured.io, {
        cwd: project,
        home,
        env: {},
        availability: { claude: { available: false, version: null }, codex: { available: true, version: "test" } },
      });
    } finally {
      await chmod(dirname(native), 0o755);
    }

    const document = JSON.parse(captured.stdout());
    expect(code!).toBe(2);
    expect(document).toMatchObject({ status: "error", error: { code: "permission-denied" } });
    expect(document.actions).toContainEqual(expect.objectContaining({ writes: [canonical] }));
    const backups = document.actions.flatMap((action: { backups?: string[] }) => action.backups ?? []);
    expect(backups.length).toBeGreaterThan(0);
    expect(await readFile(join(backups.at(-1), "SKILL.md"), "utf8")).toBe(validSkill);
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toBe(validSkill);
  });

  it("reports a recovery backup when an agent rewrite fails after backup", async () => {
    const home = await temporaryDirectory();
    const project = join(home, "project");
    const canonical = validAgent.replace(
      "  codex:\n    model_reasoning_effort: high\n    sandbox_mode: read-only\n",
      "  codex: false\n",
    );
    const native = join(project, ".claude/agents/reviewer.md");
    const nativeSource = `---\nname: reviewer\ndescription: Native copy.\n---\n\nNative instructions.\n`;
    await writeText(join(project, ".agents/overlord/agents/reviewer.md"), canonical);
    await writeText(native, nativeSource);
    await chmod(dirname(native), 0o555);
    const captured = captureIo();
    let code: number;
    try {
      code = await runCli([
        "sync",
        "--json",
        "--project",
        project,
        "--resolve",
        "agent:reviewer@project=agents",
      ], captured.io, {
        cwd: project,
        home,
        env: {},
        availability: { claude: { available: true, version: "test" }, codex: { available: false, version: null } },
      });
    } finally {
      await chmod(dirname(native), 0o755);
    }

    const document = JSON.parse(captured.stdout());
    expect(code!).toBe(2);
    expect(document).toMatchObject({ status: "error", error: { code: "permission-denied" } });
    const backups = document.actions.flatMap((action: { backups?: string[] }) => action.backups ?? []);
    expect(backups).toHaveLength(1);
    expect(await readFile(backups[0], "utf8")).toBe(nativeSource);
    expect(await readFile(native, "utf8")).toBe(nativeSource);
  });
});
