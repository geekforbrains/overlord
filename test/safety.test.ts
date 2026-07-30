import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdir, readFile, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

import { loadConfig } from "../src/config.js";
import { inspect, synchronize } from "../src/engine.js";
import { acquireScopeLock, lockPathForScope } from "../src/filesystem.js";
import { resolveTargetPaths } from "../src/targets.js";
import type { EngineOptions, Scope } from "../src/types.js";
import { cleanupTemporaryDirectories, temporaryDirectory, validAgent, validSkill, writeText } from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

async function projectFixture() {
  const home = await temporaryDirectory();
  const project = join(home, "project");
  await mkdir(project);
  const options: EngineOptions = {
    cwd: project,
    home,
    env: {},
    project,
    availability: {
      claude: { available: true, version: "test" },
      codex: { available: true, version: "test" },
    },
  };
  return { home, project, options };
}

describe("safety and edge contracts", () => {
  it("uses the same mutation lock for a physical scope and its symlink alias", async () => {
    const root = await temporaryDirectory();
    const physical = join(root, "project");
    const alias = join(root, "project-alias");
    await mkdir(physical);
    await symlink(physical, alias);
    expect(lockPathForScope(alias)).toBe(lockPathForScope(physical));
  });

  it("recovers a scope lock whose recorded owner no longer exists", async () => {
    const root = await temporaryDirectory();
    const scope = join(root, "project");
    await mkdir(scope);
    const lock = lockPathForScope(scope);
    await writeText(join(lock, "owner"), "999999999\n");

    const release = await acquireScopeLock(scope);
    await release();
    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not materialize a definition involved in an unresolvable cross-scope collision", async () => {
    const { home, project, options } = await projectFixture();
    await writeText(join(home, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await writeText(
      join(project, ".agents/skills/verify-build/SKILL.md"),
      validSkill.replace("documented build", "project build"),
    );
    const result = await synchronize(options, { dryRun: false, resolutions: {} });
    expect(result.status).toBe("attention-required");
    await expect(lstat(join(project, ".claude/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates all canonical definitions before making any missing-output write", async () => {
    const { project, options } = await projectFixture();
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await writeText(join(project, ".agents/overlord/agents/BAD.md"), validAgent.replace("name: reviewer", "name: BAD"));
    const result = await synchronize(options, { dryRun: false, resolutions: {} });
    expect(result.status).toBe("attention-required");
    await expect(lstat(join(project, ".claude/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preflights every enabled renderer before writing any target", async () => {
    const { project, options } = await projectFixture();
    await writeText(
      join(project, ".agents/overlord/agents/reviewer.md"),
      validAgent.replace("model_reasoning_effort: high", "model: null"),
    );
    const result = await synchronize(options, { dryRun: false, resolutions: {} });
    expect(result.status).toBe("attention-required");
    expect(result.definitions?.find((entry) => entry.name === "reviewer")?.state).toBe("invalid");
    await expect(lstat(join(project, ".claude/agents/reviewer.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(project, ".codex/agents/reviewer.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("makes a resolved destructive dry run describe removals without mutating", async () => {
    const { project, options } = await projectFixture();
    const native = join(project, ".claude/agents/reviewer.md");
    await writeText(native, `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`);
    const result = await synchronize(options, {
      dryRun: true,
      resolutions: { "agent:reviewer@project": "delete" },
      confirmDestructive: true,
    });
    expect(result.actions).toContainEqual(expect.objectContaining({
      requiresDecision: false,
      removes: [native],
      writes: [],
    }));
    expect(await readFile(native, "utf8")).toContain("Review.");
  });

  it("rejects ambiguous bare selectors without changing either definition", async () => {
    const { project, options } = await projectFixture();
    const skill = join(project, ".claude/skills/reviewer/SKILL.md");
    const agent = join(project, ".claude/agents/reviewer.md");
    await writeText(skill, validSkill.replaceAll("verify-build", "reviewer"));
    await writeText(agent, `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`);
    await expect(synchronize(options, { dryRun: false, resolutions: { reviewer: "adopt" } })).rejects.toMatchObject({ code: "usage" });
    await expect(lstat(join(project, ".agents/skills/reviewer"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(project, ".agents/overlord/agents/reviewer.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stale selector before performing unambiguous work", async () => {
    const { project, options } = await projectFixture();
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await expect(synchronize(options, { dryRun: false, resolutions: { obsolete: "adopt" } })).rejects.toMatchObject({ code: "usage" });
    await expect(lstat(join(project, ".claude/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the documented name@absolute-scope selector form", async () => {
    const { project, options } = await projectFixture();
    const native = join(project, ".claude/agents/reviewer.md");
    await writeText(native, `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`);
    await synchronize(options, {
      dryRun: false,
      resolutions: { [`reviewer@${project}`]: "adopt" },
    });
    expect(await readFile(join(project, ".agents/overlord/agents/reviewer.md"), "utf8")).toContain("name: reviewer");
  });

  it("preserves the other provider overlay when keeping one native agent", async () => {
    const { project, options } = await projectFixture();
    await writeText(join(project, ".agents/overlord/agents/reviewer.md"), validAgent);
    await synchronize(options, { dryRun: false, resolutions: {} });
    const claudePath = join(project, ".claude/agents/reviewer.md");
    await writeText(claudePath, (await readFile(claudePath, "utf8")).replace("model: opus", "model: sonnet"));
    await synchronize(options, { dryRun: false, resolutions: { "agent:reviewer@project": "claude" } });
    const canonical = await readFile(join(project, ".agents/overlord/agents/reviewer.md"), "utf8");
    expect(canonical).toContain("model: sonnet");
    expect(canonical).toContain("model_reasoning_effort: high");
    expect(canonical).toContain("sandbox_mode: read-only");
  });

  it("reports a native file for an explicitly disabled target as unadopted", async () => {
    const { project, options } = await projectFixture();
    await writeText(
      join(project, ".agents/overlord/agents/reviewer.md"),
      validAgent.replace(
        "  claude:\n    color: cyan\n    model: opus\n    tools: [Read, Grep, Glob]\n",
        "  claude: false\n",
      ),
    );
    const canonicalPath = join(project, ".agents/overlord/agents/reviewer.md");
    const nativePath = join(project, ".claude/agents/reviewer.md");
    await writeText(nativePath, `---\nname: reviewer\ndescription: Native copy.\n---\n\nNative.\n`);
    const result = await inspect(options);
    const matches = result.definitions?.filter((entry) => entry.kind === "agent" && entry.name === "reviewer");
    expect(matches).toHaveLength(1);
    expect(matches?.[0]).toMatchObject({ state: "unadopted", canonical: canonicalPath });

    const original = await readFile(canonicalPath, "utf8");
    const adopted = await synchronize(options, { dryRun: false, resolutions: { "agent:reviewer@project": "adopt" } });
    expect(await readFile(canonicalPath, "utf8")).not.toBe(original);
    expect(await readFile(canonicalPath, "utf8")).toContain("model_reasoning_effort: high");
    expect(adopted.actions?.some((action) => (action.backups?.length ?? 0) > 0)).toBe(true);
  });

  it("does not adopt an arbitrary duplicate when a canonical target is disabled", async () => {
    const { project, options } = await projectFixture();
    await writeText(
      join(project, ".agents/overlord/agents/reviewer.md"),
      validAgent.replace(
        "  claude:\n    color: cyan\n    model: opus\n    tools: [Read, Grep, Glob]\n",
        "  claude: false\n",
      ),
    );
    const first = join(project, ".claude/agents/one/reviewer.md");
    const second = join(project, ".claude/agents/two/reviewer.md");
    await writeText(first, `---\nname: reviewer\ndescription: First.\n---\n\nFirst.\n`);
    await writeText(second, `---\nname: reviewer\ndescription: Second.\n---\n\nSecond.\n`);

    const result = await inspect(options);
    const definition = result.definitions?.find((entry) => entry.kind === "agent" && entry.name === "reviewer");
    expect(definition).toMatchObject({
      state: "conflict",
      conflictsWith: [first, second],
      decision: { options: ["agents", "skip"] },
    });
  });

  it("respects partial external ownership in a dual-native skill group", async () => {
    const { project, options } = await projectFixture();
    const claude = join(project, ".claude/skills/verify-build");
    const codex = join(project, ".codex/skills/verify-build");
    await writeText(join(claude, "SKILL.md"), validSkill);
    await writeText(join(codex, "SKILL.md"), validSkill);
    await writeText(
      join(project, ".agents/overlord/overlord.yaml"),
      "version: 1\nexternal:\n  - kind: skill\n    name: verify-build\n    target: claude\n    reason: Claude owns this copy\n",
    );
    const result = await inspect(options);
    const definition = result.definitions?.find((entry) => entry.name === "verify-build");
    expect(definition?.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "claude", state: "external" }),
      expect.objectContaining({ target: "codex", state: "unadopted" }),
    ]));
    await synchronize(options, { dryRun: false, resolutions: { "skill:verify-build@project": "adopt" } });
    expect(await readFile(join(project, ".agents/skills/verify-build/SKILL.md"), "utf8")).toBe(validSkill);
    expect(await readFile(join(claude, "SKILL.md"), "utf8")).toBe(validSkill);
    await expect(lstat(codex)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not guess between duplicate recursive Claude agents", async () => {
    const { project, options } = await projectFixture();
    await writeText(join(project, ".claude/agents/review/reviewer.md"), `---\nname: reviewer\ndescription: First.\n---\n\nFirst.\n`);
    await writeText(join(project, ".claude/agents/research/reviewer.md"), `---\nname: reviewer\ndescription: Second.\n---\n\nSecond.\n`);
    const result = await inspect(options);
    const definition = result.definitions?.find((entry) => entry.name === "reviewer");
    expect(definition).toMatchObject({ state: "conflict" });
    expect(definition?.decision).toBeUndefined();
    expect(definition?.conflictsWith).toHaveLength(2);
  });

  it("treats a nested same-name Claude agent as a duplicate of its canonical agent", async () => {
    const { project, options } = await projectFixture();
    const canonical = validAgent.replace(
      "  codex:\n    model_reasoning_effort: high\n    sandbox_mode: read-only\n",
      "  codex: false\n",
    );
    const nested = join(project, ".claude/agents/team/reviewer.md");
    await writeText(join(project, ".agents/overlord/agents/reviewer.md"), canonical);
    await writeText(nested, `---\nname: reviewer\ndescription: Nested copy.\n---\n\nNested instructions.\n`);

    const pending = await inspect(options);
    const matches = pending.definitions?.filter((entry) => entry.kind === "agent" && entry.name === "reviewer");
    expect(matches).toHaveLength(1);
    expect(matches?.[0]).toMatchObject({ state: "conflict", conflictsWith: [nested] });

    const resolved = await synchronize(options, {
      dryRun: false,
      resolutions: { "agent:reviewer@project": "agents" },
    });
    expect(resolved.status).toBe("ok");
    await expect(lstat(nested)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(project, ".claude/agents/reviewer.md"), "utf8")).toContain("Reviews a change");
    expect(resolved.actions?.some((action) => action.removes?.includes(nested) && (action.backups?.length ?? 0) > 0)).toBe(true);
  });

  it("resolves relative user target roots to absolute paths", async () => {
    const home = await temporaryDirectory();
    const cwd = join(home, "work");
    await mkdir(cwd);
    const scope: Scope = { type: "user", path: home, canonical: join(home, ".agents"), resolvedBy: "explicit-flag", evidence: "--global" };
    const paths = resolveTargetPaths(scope, {
      cwd,
      home,
      env: { CLAUDE_CONFIG_DIR: "relative-claude", CODEX_HOME: "relative-codex" },
    });
    expect(paths.claude.skills).toBe(join(cwd, "relative-claude/skills"));
    expect(paths.codex.agents).toBe(join(cwd, "relative-codex/agents"));
  });

  it("wraps unreadable configuration as a config-invalid error", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".agents/overlord/overlord.yaml"), { recursive: true });
    await expect(loadConfig(join(root, ".agents"))).rejects.toMatchObject({ code: "config-invalid" });
  });

  it("reports the offending additional configuration key", async () => {
    const root = await temporaryDirectory();
    await writeText(join(root, ".agents/overlord/overlord.yaml"), "version: 1\nextra: true\n");
    await expect(loadConfig(join(root, ".agents"))).rejects.toMatchObject({ code: "config-invalid", message: expect.stringContaining("/extra") });
  });

  it("validates user configuration while inspecting a project", async () => {
    const { home, options } = await projectFixture();
    await writeText(join(home, ".agents/overlord/overlord.yaml"), "version: 99\n");
    await expect(inspect(options)).rejects.toMatchObject({ code: "config-invalid" });
  });

  it("refuses to write through a symlinked project-native root", async () => {
    const { home, project, options } = await projectFixture();
    const outside = join(home, "outside-skills");
    await mkdir(outside);
    await mkdir(join(project, ".claude"));
    await symlink(outside, join(project, ".claude/skills"));
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await expect(synchronize(options, { dryRun: false, resolutions: {} })).rejects.toMatchObject({ code: "permission-denied" });
    await expect(lstat(join(outside, "verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to adopt an agent through a symlinked canonical root", async () => {
    const { home, project, options } = await projectFixture();
    const outside = join(home, "outside-canonical");
    await mkdir(outside);
    await symlink(outside, join(project, ".agents"));
    const native = join(project, ".claude/agents/reviewer.md");
    await writeText(native, `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`);

    await expect(synchronize(options, {
      dryRun: false,
      resolutions: { "agent:reviewer@project": "adopt" },
    })).rejects.toMatchObject({ code: "permission-denied" });

    await expect(lstat(join(outside, "overlord/agents/reviewer.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(native, "utf8")).toContain("Review.");
  });

  it("refuses to adopt a skill through a symlinked canonical skills directory", async () => {
    const { home, project, options } = await projectFixture();
    const outside = join(home, "outside-canonical-skills");
    await mkdir(join(project, ".agents"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(project, ".agents/skills"));
    const native = join(project, ".claude/skills/verify-build");
    await writeText(join(native, "SKILL.md"), validSkill);

    await expect(synchronize(options, {
      dryRun: false,
      resolutions: { "skill:verify-build@project": "adopt" },
    })).rejects.toMatchObject({ code: "permission-denied" });

    await expect(lstat(join(outside, "verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(native, "SKILL.md"), "utf8")).toBe(validSkill);
  });

  it("preserves an internal canonical skill symlink", async () => {
    const { project, options } = await projectFixture();
    const skill = join(project, ".agents/skills/verify-build");
    await writeText(join(skill, "SKILL.md"), validSkill);
    await writeText(join(skill, "references/source.md"), "source\n");
    await symlink("source.md", join(skill, "references/current.md"));
    await synchronize(options, { dryRun: false, resolutions: {} });
    expect(await readlink(join(project, ".claude/skills/verify-build/references/current.md"))).toBe("source.md");
  });

  it("ignores operating-system artifacts consistently while copying and comparing skills", async () => {
    const { project, options } = await projectFixture();
    const canonical = join(project, ".agents/skills/verify-build");
    const native = join(project, ".claude/skills/verify-build");
    await writeText(join(canonical, "SKILL.md"), validSkill);
    await writeText(join(canonical, "Desktop.ini"), "canonical noise\n");
    await writeText(join(canonical, "._resource"), "canonical noise\n");

    await synchronize(options, { dryRun: false, resolutions: {} });
    await expect(lstat(join(native, "Desktop.ini"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(native, "._resource"))).rejects.toMatchObject({ code: "ENOENT" });

    await writeText(join(native, "ehthumbs.db"), "native noise\n");
    await writeText(join(native, "._other"), "native noise\n");
    expect((await inspect(options)).definitions?.find((entry) => entry.name === "verify-build")?.state).toBe("synced");
  });

  it("includes empty skill directories in equality checks", async () => {
    const { project, options } = await projectFixture();
    const canonical = join(project, ".agents/skills/verify-build");
    const native = join(project, ".claude/skills/verify-build");
    await writeText(join(canonical, "SKILL.md"), validSkill);
    await mkdir(join(canonical, "references/empty"), { recursive: true });
    await writeText(join(native, "SKILL.md"), validSkill);

    const result = await inspect(options);
    expect(result.definitions?.find((entry) => entry.name === "verify-build")?.state).toBe("conflict");
  });

  it("stages and validates a scan-only skill before adopting or removing it", async () => {
    const { project, options } = await projectFixture();
    const native = join(project, ".codex/skills/verify-build");
    await writeText(join(native, "SKILL.md"), validSkill);
    await symlink("/etc/hosts", join(native, "leak"));

    await expect(synchronize(options, {
      dryRun: false,
      resolutions: { "skill:verify-build@project": "adopt" },
    })).rejects.toMatchObject({ code: "permission-denied" });

    await expect(lstat(join(project, ".agents/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readlink(join(native, "leak"))).toBe("/etc/hosts");
  });

  it("refuses to delete through a symlinked native skill root", async () => {
    const { home, project, options } = await projectFixture();
    const outside = join(home, "outside-codex-skills");
    await writeText(join(outside, "verify-build/SKILL.md"), validSkill);
    await mkdir(join(project, ".codex"), { recursive: true });
    await symlink(outside, join(project, ".codex/skills"));

    await expect(synchronize(options, {
      dryRun: false,
      resolutions: { "skill:verify-build@project": "delete" },
      confirmDestructive: true,
    })).rejects.toMatchObject({ code: "permission-denied" });

    expect(await readFile(join(outside, "verify-build/SKILL.md"), "utf8")).toBe(validSkill);
  });

  it("refuses scan-only adoption through a symlinked native skill root", async () => {
    const { home, project, options } = await projectFixture();
    const outside = join(home, "outside-codex-skills");
    await writeText(join(outside, "verify-build/SKILL.md"), validSkill);
    await mkdir(join(project, ".codex"), { recursive: true });
    await symlink(outside, join(project, ".codex/skills"));

    await expect(synchronize(options, {
      dryRun: false,
      resolutions: { "skill:verify-build@project": "adopt" },
    })).rejects.toMatchObject({ code: "permission-denied" });

    await expect(lstat(join(project, ".agents/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(outside, "verify-build/SKILL.md"), "utf8")).toBe(validSkill);
  });

  it("normalizes the chosen native agent after adopting its content", async () => {
    const { project, options } = await projectFixture();
    await writeText(join(project, ".agents/overlord/agents/reviewer.md"), validAgent);
    await synchronize(options, { dryRun: false, resolutions: {} });
    const native = join(project, ".claude/agents/reviewer.md");
    await writeText(native, (await readFile(native, "utf8")).replace("model: opus", 'model: "sonnet"'));

    const result = await synchronize(options, {
      dryRun: false,
      resolutions: { "agent:reviewer@project": "claude" },
    });

    expect(result.status).toBe("ok");
    expect(await readFile(native, "utf8")).toContain("model: sonnet");
    expect((await inspect(options)).definitions?.find((entry) => entry.name === "reviewer")?.state).toBe("synced");
  });

  it("keeps executed backup metadata valid against the public output schema", async () => {
    const { project, options } = await projectFixture();
    const native = join(project, ".claude/agents/reviewer.md");
    await writeText(native, `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`);
    const result = await synchronize(options, {
      dryRun: false,
      resolutions: { "agent:reviewer@project": "delete" },
      confirmDestructive: true,
    });
    const schema = JSON.parse(await readFile(join(process.cwd(), "docs/schemas/output.schema.json"), "utf8"));
    const ajv = new Ajv2020({ allErrors: true });
    expect(ajv.validate(schema, result), JSON.stringify(ajv.errors)).toBe(true);
    expect(result.actions?.[0]?.backups?.length).toBe(1);
  });

  it("retains outstanding decision actions after completing unambiguous writes", async () => {
    const { project, options } = await projectFixture();
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await writeText(join(project, ".claude/agents/reviewer.md"), `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`);
    const result = await synchronize(options, { dryRun: false, resolutions: {} });
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "materialize-skill-verify-build-claude", writes: [join(project, ".claude/skills/verify-build")] }),
      expect.objectContaining({ id: "resolve-agent-reviewer", requiresDecision: true }),
    ]));
  });
});
