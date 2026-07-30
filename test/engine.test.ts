import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdir, readFile, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { cleanupTemporaryDirectories, temporaryDirectory, validAgent, validSkill, writeText } from "./helpers.js";
import { inspect, initialize, synchronize } from "../src/engine.js";
import { lockPathForScope } from "../src/filesystem.js";
import type { EngineOptions } from "../src/types.js";

afterEach(cleanupTemporaryDirectories);

async function fixture(availability: EngineOptions["availability"] = { claude: { available: true, version: "test" }, codex: { available: true, version: "test" } }) {
  const home = await temporaryDirectory();
  const project = join(home, "project");
  await mkdir(project);
  const options: EngineOptions = {
    cwd: project,
    home,
    env: {
      CLAUDE_CONFIG_DIR: join(home, "claude-home"),
      CODEX_HOME: join(home, "codex-home"),
    },
    project,
    availability,
  };
  return { home, project, options };
}

function codexOnlyAgent(name: string): string {
  return `---
version: 1
name: ${name}
description: Performs the ${name} review.
targets:
  claude: false
  codex: {}
---

Review carefully.
`;
}

describe("inventory and synchronization", () => {
  it("initializes canonical directories and configuration without overwriting", async () => {
    const { project, options } = await fixture();
    const first = await initialize(options, { dryRun: false });
    expect(first.status).toBe("ok");
    expect(await readFile(join(project, ".agents/overlord/overlord.yaml"), "utf8")).toBe("version: 1\nexternal: []\n");
    const second = await initialize(options, { dryRun: false });
    expect(second.actions?.every((action) => action.writes?.length === 0)).toBe(true);
  });

  it("installs the bundled skill only for global initialization", async () => {
    const { home, options } = await fixture();
    const globalOptions = { ...options, project: undefined, global: true } satisfies EngineOptions;
    await initialize(globalOptions, { dryRun: false });
    expect(await readFile(join(home, ".agents/skills/overlord/SKILL.md"), "utf8")).toContain("overlord status --json");
  });

  it("reports canonical skills missing only from Claude because Codex reads them directly", async () => {
    const { project, options } = await fixture();
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    const result = await inspect(options);
    const definition = result.definitions?.find((entry) => entry.name === "verify-build");
    expect(definition).toMatchObject({ kind: "skill", state: "missing" });
    expect(definition?.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "codex", state: "synced", readsCanonicalDirectly: true }),
      expect.objectContaining({ target: "claude", state: "missing" }),
    ]));
  });

  it("copies missing skills byte-for-byte, preserves modes, and becomes idempotent", async () => {
    const { project, options } = await fixture();
    const source = join(project, ".agents/skills/verify-build");
    await writeText(join(source, "SKILL.md"), validSkill);
    await writeText(join(source, "scripts/check.sh"), "#!/bin/sh\nexit 0\n", 0o751);
    const first = await synchronize(options, { dryRun: false, resolutions: {} });
    expect(first.status).toBe("ok");
    const destination = join(project, ".claude/skills/verify-build");
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe(validSkill);
    expect((await lstat(join(destination, "scripts/check.sh"))).mode & 0o777).toBe(0o751);
    const before = (await lstat(join(destination, "SKILL.md"))).mtimeMs;
    const second = await synchronize(options, { dryRun: false, resolutions: {} });
    expect(second.actions?.flatMap((action) => action.writes ?? [])).toEqual([]);
    expect((await lstat(join(destination, "SKILL.md"))).mtimeMs).toBe(before);
  });

  it("renders one canonical agent to both native formats", async () => {
    const { project, options } = await fixture();
    await writeText(join(project, ".agents/overlord/agents/reviewer.md"), validAgent);
    await synchronize(options, { dryRun: false, resolutions: {} });
    const claude = await readFile(join(project, ".claude/agents/reviewer.md"), "utf8");
    const codex = parseToml(await readFile(join(project, ".codex/agents/reviewer.toml"), "utf8"));
    expect(claude).toContain("color: cyan");
    expect(codex).toMatchObject({ name: "reviewer", sandbox_mode: "read-only", developer_instructions: expect.stringContaining("Review the requested change") });
    expect((await inspect(options)).definitions?.find((entry) => entry.name === "reviewer")?.state).toBe("synced");
  });

  it("does not report outputs for a disabled target", async () => {
    const { project, options } = await fixture();
    await writeText(
      join(project, ".agents/overlord/agents/reviewer.md"),
      validAgent.replace(
        "  claude:\n    color: cyan\n    model: opus\n    tools: [Read, Grep, Glob]\n",
        "  claude: false\n",
      ),
    );
    const result = await inspect(options);
    const outputs = result.definitions?.find((entry) => entry.name === "reviewer")?.outputs;
    expect(outputs?.map((output) => output.target)).toEqual(["codex"]);
  });

  it("blocks all sync writes when a canonical target overlay is invalid", async () => {
    const { project, options } = await fixture();
    await writeText(
      join(project, ".agents/overlord/agents/reviewer.md"),
      validAgent.replace(
        "  claude:\n    color: cyan\n    model: opus\n    tools: [Read, Grep, Glob]\n",
        "  claude: true\n",
      ),
    );

    const inspected = await inspect(options);
    expect(inspected.definitions?.find((entry) => entry.name === "reviewer")?.state).toBe("invalid");

    const result = await synchronize(options, { dryRun: false, resolutions: {} });
    expect(result.status).toBe("attention-required");
    await expect(lstat(join(project, ".claude/agents/reviewer.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(project, ".codex/agents/reviewer.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("diagnoses a directory occupying a native agent file before dry-run mutation planning", async () => {
    const { project, options } = await fixture();
    await writeText(join(project, ".agents/overlord/agents/reviewer.md"), codexOnlyAgent("reviewer"));
    const occupied = join(project, ".codex/agents/reviewer.toml");
    await mkdir(occupied, { recursive: true });

    const result = await synchronize(options, { dryRun: true, resolutions: {} });
    const definition = result.definitions?.find((entry) => entry.name === "reviewer");

    expect(definition?.state).toBe("invalid");
    expect(definition?.outputs).toContainEqual(expect.objectContaining({
      target: "codex",
      path: occupied,
      state: "invalid",
    }));
    expect(definition?.evidence).toMatch(/directory|expected.*file/i);
    expect(result.actions?.flatMap((action) => action.writes ?? [])).not.toContain(occupied);
    expect((await lstat(occupied)).isDirectory()).toBe(true);
  });

  it("preflights every native agent destination before writing an earlier missing output", async () => {
    const { project, options } = await fixture();
    await writeText(join(project, ".agents/overlord/agents/alpha.md"), codexOnlyAgent("alpha"));
    await writeText(join(project, ".agents/overlord/agents/beta.md"), codexOnlyAgent("beta"));
    const alphaOutput = join(project, ".codex/agents/alpha.toml");
    const occupied = join(project, ".codex/agents/beta.toml");
    await mkdir(occupied, { recursive: true });

    const result = await synchronize(options, { dryRun: false, resolutions: {} });

    expect(result.status).toBe("attention-required");
    await expect(lstat(alphaOutput)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(occupied)).isDirectory()).toBe(true);
    expect(result.definitions?.find((entry) => entry.name === "beta")?.state).toBe("invalid");
  });

  it("warns and omits missing states for an unavailable target", async () => {
    const { project, options } = await fixture({ claude: { available: false, version: null }, codex: { available: true, version: "test" } });
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    const result = await inspect(options);
    expect(result.targets).toContainEqual(expect.objectContaining({ name: "claude", available: false }));
    expect(result.definitions?.find((entry) => entry.name === "verify-build")?.state).toBe("synced");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "target-unavailable", severity: "warning" }));
  });

  it("reports and preserves conflicts until explicitly resolved", async () => {
    const { project, options } = await fixture();
    const canonical = join(project, ".agents/skills/verify-build/SKILL.md");
    const native = join(project, ".claude/skills/verify-build/SKILL.md");
    await writeText(canonical, validSkill);
    await writeText(native, validSkill.replace("Run the documented build", "Run a different build"));
    const pending = await synchronize(options, { dryRun: false, resolutions: {} });
    const definition = pending.definitions?.find((entry) => entry.name === "verify-build");
    expect(pending.status).toBe("attention-required");
    expect(definition).toMatchObject({ state: "conflict", decision: { options: ["agents", "claude", "skip"] } });
    expect(await readFile(native, "utf8")).toContain("different build");

    await synchronize(options, { dryRun: false, resolutions: { "skill:verify-build@project": "agents" } });
    expect(await readFile(native, "utf8")).toBe(validSkill);
  });

  it("adopts a Claude skill and materializes the same canonical bytes", async () => {
    const { project, options } = await fixture();
    const native = join(project, ".claude/skills/verify-build/SKILL.md");
    await writeText(native, validSkill);
    const pending = await inspect(options);
    expect(pending.definitions?.[0]).toMatchObject({ state: "unadopted", decision: { options: ["adopt", "external", "delete", "skip"] } });
    await synchronize(options, { dryRun: false, resolutions: { "skill:verify-build@project": "adopt" } });
    expect(await readFile(join(project, ".agents/skills/verify-build/SKILL.md"), "utf8")).toBe(validSkill);
    expect((await inspect(options)).summary?.adoptionComplete).toBe(true);
  });

  it("moves an adopted scan-only Codex skill and retains a recoverable backup", async () => {
    const { project, options } = await fixture();
    const native = join(project, ".codex/skills/verify-build");
    await writeText(join(native, "SKILL.md"), validSkill);
    const result = await synchronize(options, { dryRun: false, resolutions: { "skill:verify-build@project": "adopt" } });
    expect(await readFile(join(project, ".agents/skills/verify-build/SKILL.md"), "utf8")).toBe(validSkill);
    await expect(lstat(native)).rejects.toMatchObject({ code: "ENOENT" });
    const backup = result.actions?.flatMap((action) => action.backups ?? [])[0];
    expect(backup).toBeTruthy();
    expect(await readFile(join(backup!, "SKILL.md"), "utf8")).toBe(validSkill);
  });

  it("adopts native agents without translating target-only fields", async () => {
    const { project, options } = await fixture();
    await writeText(join(project, ".claude/agents/reviewer.md"), `---\nname: reviewer\ndescription: Reviews changes.\nmodel: opus\ncolor: blue\n---\n\nReview carefully.\n`);
    await synchronize(options, { dryRun: false, resolutions: { "agent:reviewer@project": "adopt" } });
    const canonical = await readFile(join(project, ".agents/overlord/agents/reviewer.md"), "utf8");
    expect(canonical).toContain("model: opus");
    expect(canonical).toContain("color: blue");
    expect(canonical).toContain("codex: {}");
  });

  it("reports every provider output planned by a dry-run agent adoption", async () => {
    const { project, options } = await fixture();
    const claude = join(project, ".claude/agents/reviewer.md");
    const canonical = join(project, ".agents/overlord/agents/reviewer.md");
    const codex = join(project, ".codex/agents/reviewer.toml");
    const native = `---\nname: reviewer\ndescription: Reviews changes.\nmodel: opus\n---\n\nReview carefully.\n`;
    await writeText(claude, native);

    const result = await synchronize(options, {
      dryRun: true,
      resolutions: { "agent:reviewer@project": "adopt" },
    });

    expect(result.actions).toContainEqual(expect.objectContaining({
      id: "plan-adopt-agent-reviewer",
      writes: [canonical, claude, codex],
    }));
    expect(await readFile(claude, "utf8")).toBe(native);
    await expect(lstat(canonical)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(codex)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks unadopted files external in configuration without changing them", async () => {
    const { project, options } = await fixture();
    const native = join(project, ".claude/agents/reviewer.md");
    const contents = `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`;
    await writeText(native, contents);
    await synchronize(options, { dryRun: false, resolutions: { "agent:reviewer@project": "external" } });
    expect(await readFile(native, "utf8")).toBe(contents);
    expect(await readFile(join(project, ".agents/overlord/overlord.yaml"), "utf8")).toContain("target: claude");
    expect((await inspect(options)).definitions?.[0]?.state).toBe("external");
  });

  it("deletes only with an explicit resolution and retains a backup", async () => {
    const { project, options } = await fixture();
    const native = join(project, ".claude/agents/reviewer.md");
    await writeText(native, `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`);
    await synchronize(options, { dryRun: false, resolutions: {} });
    expect(await lstat(native)).toBeTruthy();
    const deleted = await synchronize(options, { dryRun: false, resolutions: { "agent:reviewer@project": "delete" }, confirmDestructive: true });
    await expect(lstat(native)).rejects.toMatchObject({ code: "ENOENT" });
    expect(deleted.actions?.some((action) => (action.backups?.length ?? 0) > 0)).toBe(true);
  });

  it("never mutates on a dry run", async () => {
    const { project, options } = await fixture();
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    const result = await synchronize(options, { dryRun: true, resolutions: {} });
    expect(result.dryRun).toBe(true);
    expect(result.actions?.some((action) => (action.writes?.length ?? 0) > 0)).toBe(true);
    await expect(lstat(join(project, ".claude/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports scan-only duplicates and skips .system", async () => {
    const { project, options } = await fixture();
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await writeText(join(project, ".codex/skills/verify-build/SKILL.md"), validSkill);
    await writeText(join(project, ".codex/skills/.system/internal/SKILL.md"), validSkill.replaceAll("verify-build", "internal"));
    const result = await inspect(options);
    expect(result.definitions?.find((entry) => entry.name === "verify-build")?.state).toBe("conflict");
    expect(result.definitions?.some((entry) => entry.name === "internal")).toBe(false);
  });

  it("treats a symlink to canonical as synced and a dangling symlink as invalid", async () => {
    const { project, options } = await fixture();
    const canonical = join(project, ".agents/skills/verify-build");
    const native = join(project, ".claude/skills/verify-build");
    await writeText(join(canonical, "SKILL.md"), validSkill);
    await mkdir(join(native, ".."), { recursive: true });
    await symlink(canonical, native);
    expect((await inspect(options)).definitions?.find((entry) => entry.name === "verify-build")?.state).toBe("synced");
    expect(await readlink(native)).toBe(canonical);

    const dangling = join(project, ".claude/skills/dangling");
    await symlink(join(project, "missing"), dangling);
    const result = await inspect(options);
    expect(result.definitions?.find((entry) => entry.name === "dangling")?.state).toBe("invalid");
  });

  it("reports cross-scope collisions without offering a resolution", async () => {
    const { home, project, options } = await fixture();
    await writeText(join(home, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill.replace("documented build", "project build"));
    const result = await inspect(options);
    const collisions = result.definitions?.filter((entry) => entry.name === "verify-build" && entry.state === "conflict");
    expect(collisions).toHaveLength(2);
    expect(collisions?.every((entry) => entry.decision === undefined)).toBe(true);
  });

  it("reports legacy Claude commands as diagnostics without failing check state", async () => {
    const { project, options } = await fixture();
    await writeText(join(project, ".claude/commands/deploy.md"), "Deploy safely.\n");
    const result = await inspect(options);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "unmanaged-claude-command", severity: "warning" }));
    expect(result.summary?.total).toBe(0);
  });

  it("detects an already-held mutation lock", async () => {
    const { project, options } = await fixture();
    await mkdir(lockPathForScope(project), { recursive: true });
    await expect(synchronize(options, { dryRun: false, resolutions: {} })).rejects.toMatchObject({ code: "lock-held" });
  });
});
