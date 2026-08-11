import { afterEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdir, readFile, readlink, realpath, stat, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";

import { initialize, inspect, synchronize } from "../src/engine.js";
import { acquireScopeLock, assertNoSymlinkedParent, lockPathForScope } from "../src/filesystem.js";
import type { EngineOptions } from "../src/types.js";
import { cleanupTemporaryDirectories, temporaryDirectory, validAgent, validSkill, writeText } from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

function namedSkill(name: string, body = "Run the documented build and report concrete failures."): string {
  return validSkill
    .replaceAll("verify-build", name)
    .replace("Run the documented build and report concrete failures.", body);
}

async function fleetFixture() {
  const home = await temporaryDirectory();
  const fleetRoot = await temporaryDirectory();
  const options: EngineOptions = {
    home,
    env: {
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
    },
  };
  await writeText(
    join(home, ".agents/overlord/overlord.yaml"),
    `roots:\n  - ${fleetRoot}\n`,
  );
  return { home, fleetRoot, options };
}

function scopeDiagnostic(result: Awaited<ReturnType<typeof synchronize>>, scopePath: string) {
  return result.diagnostics?.find((entry) => entry.scopePath === scopePath && entry.severity === "error");
}

describe("fleet safety contracts", () => {
  it("initializes and synchronizes through a stable user-home symlink alias", async () => {
    const physicalHome = await temporaryDirectory();
    const aliasParent = await temporaryDirectory();
    const home = join(aliasParent, "home");
    await symlink(physicalHome, home);
    const options: EngineOptions = { home, env: {} };

    expect((await initialize(options)).status).toBe("ok");
    await writeText(join(home, ".agents/skills/verify-build/SKILL.md"), validSkill);

    const before = await inspect(options);
    expect(before.definitions).toContainEqual(expect.objectContaining({
      kind: "skill",
      name: "verify-build",
      scopePath: home,
      state: "missing",
    }));

    const result = await synchronize(options);

    expect(result.status).toBe("ok");
    expect(result.scopes?.[0]).toMatchObject({ type: "user", path: home });
    expect(await readFile(join(physicalHome, ".claude/skills/verify-build/SKILL.md"), "utf8")).toBe(validSkill);
  });

  it("rejects a user-home alias when it no longer resolves to its pinned physical directory", async () => {
    const physicalHome = await temporaryDirectory();
    const otherHome = await temporaryDirectory();
    const aliasParent = await temporaryDirectory();
    const home = join(aliasParent, "home");
    await symlink(physicalHome, home);
    const pinnedHome = await realpath(home);
    await unlink(home);
    await symlink(otherHome, home);

    await expect(assertNoSymlinkedParent(
      join(home, ".agents/skills/example/SKILL.md"),
      home,
      pinnedHome,
    )).rejects.toMatchObject({ code: "permission-denied", path: home });
  });

  it("still refuses a symlinked provider parent below a user-home alias", async () => {
    const physicalHome = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const aliasParent = await temporaryDirectory();
    const home = join(aliasParent, "home");
    await symlink(physicalHome, home);
    await writeText(join(home, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await symlink(outside, join(home, ".claude"));
    const options: EngineOptions = { home, env: {} };

    const result = await synchronize(options);

    expect(scopeDiagnostic(result, home)).toMatchObject({ code: "permission-denied" });
    await expect(lstat(join(outside, "skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
  });

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

  it("isolates an invalid scope while synchronizing a healthy scope", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const broken = join(fleetRoot, "broken");
    const healthy = join(fleetRoot, "healthy");
    await writeText(
      join(broken, ".agents/overlord/agents/BAD.md"),
      validAgent.replace("name: reviewer", "name: BAD"),
    );
    await writeText(join(healthy, ".agents/skills/healthy-skill/SKILL.md"), namedSkill("healthy-skill"));

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({ scopePath: broken, state: "invalid" }));
    expect(await readFile(join(healthy, ".claude/skills/healthy-skill/SKILL.md"), "utf8")).toContain("name: healthy-skill");
    await expect(lstat(join(broken, ".claude/agents/BAD.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates every canonical definition in a scope before writing any output", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await writeText(
      join(project, ".agents/overlord/agents/BAD.md"),
      validAgent.replace("name: reviewer", "name: BAD"),
    );

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    await expect(lstat(join(project, ".claude/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preflights every renderer in a scope before writing any output", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await writeText(
      join(project, ".agents/overlord/agents/reviewer.md"),
      validAgent.replace("model_reasoning_effort: high", "model: null"),
    );

    const result = await synchronize(options);

    expect(result.definitions).toContainEqual(expect.objectContaining({
      kind: "agent",
      name: "reviewer",
      scopePath: project,
      state: "invalid",
    }));
    await expect(lstat(join(project, ".claude/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(project, ".claude/agents/reviewer.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(project, ".codex/agents/reviewer.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never mutates either side of a conflict", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const canonical = namedSkill("shared-skill", "Use the canonical workflow.");
    const native = namedSkill("shared-skill", "Use the native workflow.");
    const canonicalPath = join(project, ".agents/skills/shared-skill/SKILL.md");
    const nativePath = join(project, ".claude/skills/shared-skill/SKILL.md");
    await writeText(canonicalPath, canonical);
    await writeText(nativePath, native);

    const result = await synchronize(options);

    expect(result.definitions).toContainEqual(expect.objectContaining({
      name: "shared-skill",
      scopePath: project,
      state: "conflict",
    }));
    expect(await readFile(canonicalPath, "utf8")).toBe(canonical);
    expect(await readFile(nativePath, "utf8")).toBe(native);
    expect(result.actions?.filter((action) => action.scopePath === project)).toEqual([]);
  });

  it("preserves an invalid native agent whose declared name differs from its filename", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const nativePath = join(project, ".claude/agents/reviewer.md");
    const mismatched = `---\nname: auditor\ndescription: Audits changes.\n---\n\nAudit carefully.\n`;
    await writeText(join(project, ".agents/overlord/agents/reviewer.md"), validAgent);
    await writeText(nativePath, mismatched);

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({
      kind: "agent",
      name: "reviewer",
      scopePath: project,
      state: "invalid",
    }));
    expect(await readFile(nativePath, "utf8")).toBe(mismatched);
    await expect(lstat(join(project, ".codex/agents/reviewer.toml"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.actions?.filter((action) => action.scopePath === project)).toEqual([]);
  });

  it("never overwrites a case-folded native agent path while materializing a missing output", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const uppercasePath = join(project, ".claude/agents/REVIEWER.md");
    const lowercasePath = join(project, ".claude/agents/reviewer.md");
    const original = `---\nname: REVIEWER\ndescription: Preserve these bytes.\n---\n\nDO NOT LOSE\n`;
    await writeText(join(project, ".agents/overlord/agents/reviewer.md"), validAgent);
    await writeText(uppercasePath, original);
    const pathsAlias = await readFile(lowercasePath, "utf8").then(() => true, () => false);

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(await readFile(uppercasePath, "utf8")).toBe(original);
    expect(await readFile(lowercasePath, "utf8")).toContain(pathsAlias ? "DO NOT LOSE" : "name: reviewer");
    const reportsAliasedAgent = result.definitions?.some((definition) => definition.kind === "agent"
      && definition.name === "reviewer"
      && definition.scopePath === project
      && definition.state === "invalid") ?? false;
    expect(reportsAliasedAgent).toBe(pathsAlias);
    expect((result.actions?.filter((action) => action.scopePath === project).length ?? 0) === 0).toBe(pathsAlias);
  });

  it("materializes a missing target while preserving a conflicting target", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const claudePath = join(project, ".claude/agents/reviewer.md");
    const codexPath = join(project, ".codex/agents/reviewer.toml");
    const conflicting = `---\nname: reviewer\ndescription: Reviews changes.\nmodel: haiku\n---\n\nUse the native workflow.\n`;
    await writeText(join(project, ".agents/overlord/agents/reviewer.md"), validAgent);
    await writeText(claudePath, conflicting);

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({
      kind: "agent",
      name: "reviewer",
      scopePath: project,
      state: "conflict",
    }));
    expect(await readFile(claudePath, "utf8")).toBe(conflicting);
    expect(await readFile(codexPath, "utf8")).toContain('name = "reviewer"');
  });

  it("refuses provider import through a symlinked canonical root", async () => {
    const { home, fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const outside = join(home, "outside-canonical");
    const native = join(project, ".claude/agents/reviewer.md");
    await mkdir(project, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(project, ".agents"));
    await writeText(native, `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`);

    const result = await synchronize(options);

    expect(scopeDiagnostic(result, project)).toMatchObject({ code: "invalid-canonical-root" });
    await expect(lstat(join(outside, "overlord/agents/reviewer.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(native, "utf8")).toContain("Review.");
  });

  it("refuses to write through a symlinked provider-native root", async () => {
    const { home, fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const outside = join(home, "outside-claude-skills");
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await mkdir(join(project, ".claude"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(project, ".claude/skills"));

    const result = await synchronize(options);

    expect(scopeDiagnostic(result, project)).toMatchObject({ code: "permission-denied" });
    await expect(lstat(join(outside, "verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(project, ".agents/skills/verify-build/SKILL.md"), "utf8")).toBe(validSkill);
  });

  it("rejects a project Claude skills root that points exactly to canonical skills", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const canonicalSkills = join(project, ".agents/skills");
    const claudeSkills = join(project, ".claude/skills");
    await writeText(join(canonicalSkills, "verify-build/SKILL.md"), validSkill);
    await mkdir(join(project, ".claude"), { recursive: true });
    await symlink("../.agents/skills", claudeSkills);

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(scopeDiagnostic(result, project)).toBeDefined();
    expect(await readlink(claudeSkills)).toBe("../.agents/skills");
    expect(result.actions?.filter((action) => action.scopePath === project)).toEqual([]);
  });

  it("does not inventory or import agents through a symlinked provider root", async () => {
    const { home, fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const outside = join(home, "outside-agents");
    await writeText(join(project, ".agents/skills/anchor/SKILL.md"), namedSkill("anchor"));
    await writeText(join(outside, "reviewer.md"), `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`);
    await mkdir(join(project, ".claude"), { recursive: true });
    await symlink(outside, join(project, ".claude/agents"));

    const result = await synchronize(options);

    expect(scopeDiagnostic(result, project)).toBeDefined();
    await expect(lstat(join(project, ".agents/overlord/agents/reviewer.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(outside, "reviewer.md"), "utf8")).toContain("Review.");
  });

  it("does not inventory provider artifacts through a symlinked provider parent", async () => {
    const { home, fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const outside = join(home, "outside-claude");
    await writeText(
      join(project, ".agents/overlord/agents/anchor.md"),
      `---\nversion: 1\nname: anchor\ndescription: Anchors discovery.\ntargets:\n  claude: false\n  codex: false\n---\n\nAnchor.\n`,
    );
    await writeText(join(outside, "agents/external.md"), `---\nname: external\ndescription: External.\n---\n\nStay external.\n`);
    await symlink(outside, join(project, ".claude"));

    const result = await synchronize(options);

    expect(scopeDiagnostic(result, project)).toMatchObject({ code: "permission-denied" });
    await expect(lstat(join(project, ".agents/overlord/agents/external.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(outside, "agents/external.md"), "utf8")).toContain("Stay external.");
  });

  it("does not inventory canonical skills through a symlinked canonical skills root", async () => {
    const { home, fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const outside = join(home, "outside-canonical-skills");
    await writeText(join(outside, "verify-build/SKILL.md"), validSkill);
    await writeText(join(project, ".claude/agents/anchor.md"), `---\nname: anchor\ndescription: Anchors discovery.\n---\n\nAnchor.\n`);
    await mkdir(join(project, ".agents"), { recursive: true });
    await symlink(outside, join(project, ".agents/skills"));

    const result = await synchronize(options);

    expect(scopeDiagnostic(result, project)).toBeDefined();
    await expect(lstat(join(project, ".claude/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(outside, "verify-build/SKILL.md"), "utf8")).toBe(validSkill);
  });

  it("rejects and preserves an internal canonical skill symlink", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const skill = join(project, ".agents/skills/verify-build");
    await writeText(join(skill, "SKILL.md"), validSkill);
    await writeText(join(skill, "references/source.md"), "source\n");
    await symlink("source.md", join(skill, "references/current.md"));

    const link = join(skill, "references/current.md");
    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({
      kind: "skill",
      name: "verify-build",
      scopePath: project,
      state: "invalid",
    }));
    expect(await readlink(link)).toBe("source.md");
    await expect(lstat(join(project, ".claude/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("filters operating-system artifacts consistently while copying and comparing skills", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const canonical = join(project, ".agents/skills/verify-build");
    const native = join(project, ".claude/skills/verify-build");
    await writeText(join(canonical, "SKILL.md"), validSkill);
    await writeText(join(canonical, ".DS_Store"), "canonical noise\n");
    await writeText(join(canonical, "._resource"), "canonical noise\n");
    await writeText(join(canonical, ".env.example"), "SAFE=true\n");

    await synchronize(options);

    await expect(lstat(join(native, ".DS_Store"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(native, "._resource"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(native, ".env.example"), "utf8")).toBe("SAFE=true\n");
    await writeText(join(native, "Desktop.ini"), "native noise\n");
    await writeText(join(native, "._other"), "native noise\n");
    expect((await inspect(options)).definitions).toContainEqual(expect.objectContaining({
      name: "verify-build",
      scopePath: project,
      state: "synced",
    }));
  });

  it("preserves empty directories and file modes in materialized skills", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const canonical = join(project, ".agents/skills/verify-build");
    const native = join(project, ".claude/skills/verify-build");
    const script = join(canonical, "scripts/check.sh");
    await writeText(join(canonical, "SKILL.md"), validSkill);
    await writeText(script, "#!/bin/sh\n", 0o751);
    await mkdir(join(canonical, "references/empty"), { recursive: true, mode: 0o750 });

    await synchronize(options);

    expect((await stat(join(native, "scripts/check.sh"))).mode & 0o777).toBe((await stat(script)).mode & 0o777);
    expect((await stat(join(native, "references/empty"))).isDirectory()).toBe(true);
    expect((await inspect(options)).definitions).toContainEqual(expect.objectContaining({
      name: "verify-build",
      scopePath: project,
      state: "synced",
    }));
  });

  it("populates read-only skill directories before restoring their modes", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const canonical = join(project, ".agents/skills/verify-build");
    const lockedDirectory = join(canonical, "references/locked");
    await writeText(join(canonical, "SKILL.md"), validSkill);
    await writeText(join(lockedDirectory, "guide.md"), "read only\n");
    await chmod(lockedDirectory, 0o555);

    const nativeDirectory = join(project, ".claude/skills/verify-build/references/locked");
    try {
      const result = await synchronize(options);
      expect(result.status).toBe("ok");
      expect(await readFile(join(nativeDirectory, "guide.md"), "utf8")).toBe("read only\n");
      expect((await stat(nativeDirectory)).mode & 0o777).toBe(0o555);
    } finally {
      await chmod(lockedDirectory, 0o755);
      await chmod(nativeDirectory, 0o755).catch(() => undefined);
    }
  });

  it("rejects and preserves an internal native skill symlink even when it stays inside the skill", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const native = join(project, ".claude/skills/verify-build");
    const link = join(native, "references/current.md");
    await writeText(join(native, "SKILL.md"), validSkill);
    await writeText(join(native, "references/source.md"), "source\n");
    await symlink("source.md", link);

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({
      kind: "skill",
      name: "verify-build",
      scopePath: project,
      state: "invalid",
    }));
    expect(await readlink(link)).toBe("source.md");
    await expect(lstat(join(project, ".agents/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "reports an unreadable native skill payload before import",
    async () => {
      const { fleetRoot, options } = await fleetFixture();
      const project = join(fleetRoot, "project");
      const native = join(project, ".claude/skills/verify-build");
      const unreadable = join(native, "references/private.md");
      await writeText(join(native, "SKILL.md"), validSkill);
      await writeText(unreadable, "private\n");
      await chmod(unreadable, 0o000);

      try {
        const result = await synchronize(options);
        expect(result.definitions).toContainEqual(expect.objectContaining({
          kind: "skill",
          name: "verify-build",
          scopePath: project,
          state: "invalid",
        }));
        await expect(lstat(join(project, ".agents/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await chmod(unreadable, 0o600);
      }
    },
  );

  it("does not import a native skill whose internal symlink chain physically escapes", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const skills = join(project, ".claude/skills");
    const escape = join(skills, "escape");
    await writeText(join(escape, "SKILL.md"), namedSkill("escape"));
    await writeText(join(skills, "secret/SKILL.md"), namedSkill("secret"));
    await symlink(".", join(escape, "pivot"));
    await symlink("pivot/../secret/SKILL.md", join(escape, "leak"));

    const result = await synchronize(options);

    expect(result.definitions).toContainEqual(expect.objectContaining({
      kind: "skill",
      name: "escape",
      scopePath: project,
      state: "invalid",
    }));
    await expect(lstat(join(project, ".agents/skills/escape"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not import a native-only skill symlink from outside its scope", async () => {
    const { home, fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const outside = join(home, "outside-skill");
    const native = join(project, ".claude/skills/verify-build");
    await writeText(join(outside, "SKILL.md"), validSkill);
    await mkdir(join(native, ".."), { recursive: true });
    await symlink(outside, native);

    const result = await synchronize(options);

    expect(result.definitions).toContainEqual(expect.objectContaining({
      kind: "skill",
      name: "verify-build",
      scopePath: project,
      state: "invalid",
    }));
    await expect(lstat(join(project, ".agents/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readlink(native)).toBe(outside);
  });

  it("does not import a native-only agent symlink from outside its scope", async () => {
    const { home, fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const outside = join(home, "outside-agent.md");
    const native = join(project, ".claude/agents/reviewer.md");
    await writeText(outside, `---\nname: reviewer\ndescription: Reviews.\n---\n\nReview.\n`);
    await mkdir(join(native, ".."), { recursive: true });
    await symlink(outside, native);

    const result = await synchronize(options);

    expect(result.definitions).toContainEqual(expect.objectContaining({
      kind: "agent",
      name: "reviewer",
      scopePath: project,
      state: "invalid",
    }));
    await expect(lstat(join(project, ".agents/overlord/agents/reviewer.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readlink(native)).toBe(outside);
  });

  it("preserves a provider-native agent when atomic replacement fails", async () => {
    const { fleetRoot, options } = await fleetFixture();
    const project = join(fleetRoot, "project");
    const native = join(project, ".claude/agents/reviewer.md");
    const source = `---\ndescription: Reviews.\nname: reviewer\n---\n\nReview.\n`;
    await writeText(native, source);
    await chmod(join(project, ".claude/agents"), 0o555);

    let result: Awaited<ReturnType<typeof synchronize>>;
    try {
      result = await synchronize(options);
    } finally {
      await chmod(join(project, ".claude/agents"), 0o755);
    }
    expect(scopeDiagnostic(result, project)).toBeDefined();
    expect(await readFile(native, "utf8")).toBe(source);
  });

  it("continues to healthy siblings after one scope fails during mutation", async () => {
    const { home, fleetRoot, options } = await fleetFixture();
    const broken = join(fleetRoot, "broken");
    const healthy = join(fleetRoot, "healthy");
    const outside = join(home, "outside-native-root");
    await writeText(join(broken, ".agents/skills/broken-skill/SKILL.md"), namedSkill("broken-skill"));
    await mkdir(join(broken, ".claude"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(broken, ".claude/skills"));
    await writeText(join(healthy, ".agents/skills/healthy-skill/SKILL.md"), namedSkill("healthy-skill"));

    const result = await synchronize(options);

    expect(scopeDiagnostic(result, broken)).toMatchObject({ code: "permission-denied" });
    expect(await readFile(join(healthy, ".claude/skills/healthy-skill/SKILL.md"), "utf8")).toContain("name: healthy-skill");
    await expect(lstat(join(outside, "broken-skill"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves relative user target roots from home regardless of cwd", async () => {
    const { home } = await fleetFixture();
    const cwd = await temporaryDirectory();
    const options: EngineOptions = {
      home,
      env: {
        CLAUDE_CONFIG_DIR: "relative-claude",
        CODEX_HOME: "relative-codex",
      },
    };
    await writeText(join(home, ".agents/overlord/agents/reviewer.md"), validAgent);
    const originalCwd = process.cwd();

    let result: Awaited<ReturnType<typeof synchronize>>;
    try {
      process.chdir(cwd);
      result = await synchronize(options);
    } finally {
      process.chdir(originalCwd);
    }

    expect(result.status).toBe("ok");
    expect(await readFile(join(home, "relative-claude/agents/reviewer.md"), "utf8")).toContain("name: reviewer");
    expect(await readFile(join(home, "relative-codex/agents/reviewer.toml"), "utf8")).toContain('name = "reviewer"');
    await expect(lstat(join(cwd, "relative-claude"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(cwd, "relative-codex"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks user target roots that overlap the user canonical source", async () => {
    const home = await temporaryDirectory();
    const canonical = join(home, ".agents/skills/critical");
    const options: EngineOptions = {
      home,
      env: { CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".agents") },
    };
    await writeText(join(home, ".agents/overlord/overlord.yaml"), "roots: []\n");
    await writeText(join(canonical, "SKILL.md"), namedSkill("critical"));

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "artifact-root-overlap",
      scopePath: home,
    }));
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("name: critical");
    expect(result.actions?.some((action) => action.removes?.includes(canonical))).toBe(false);
  });

  it("blocks a symlinked user target root that aliases canonical source", async () => {
    const home = await temporaryDirectory();
    const canonical = join(home, ".agents/skills/critical");
    const codexAlias = join(home, "codex-alias");
    const options: EngineOptions = {
      home,
      env: { CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: codexAlias },
    };
    await writeText(join(home, ".agents/overlord/overlord.yaml"), "roots: []\n");
    await writeText(join(canonical, "SKILL.md"), namedSkill("critical"));
    await symlink(join(home, ".agents"), codexAlias);

    const result = await synchronize(options);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "artifact-root-overlap",
      scopePath: home,
    }));
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("name: critical");
  });

  it("blocks a case-folded user target root that aliases canonical source", async () => {
    const home = await temporaryDirectory();
    const canonical = join(home, ".agents/skills/critical");
    const caseAlias = join(home, ".AGENTS");
    const options: EngineOptions = {
      home,
      env: { CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: caseAlias },
    };
    await writeText(join(home, ".agents/overlord/overlord.yaml"), "roots: []\n");
    await writeText(join(canonical, "SKILL.md"), namedSkill("critical"));
    const pathsAlias = await realpath(caseAlias).then(() => true, () => false);

    const result = await synchronize(options);

    expect(result.diagnostics?.some((entry) => entry.code === "artifact-root-overlap" && entry.scopePath === home)).toBe(pathsAlias);
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("name: critical");
  });

  it("blocks not-yet-created case-folded provider roots on macOS", async () => {
    if (process.platform !== "darwin") return;
    const home = await temporaryDirectory();
    const canonical = join(home, ".agents/skills/critical");
    const claudeRoot = join(home, ".Provider");
    const options: EngineOptions = {
      home,
      env: { CLAUDE_CONFIG_DIR: claudeRoot, CODEX_HOME: join(home, ".provider") },
    };
    await writeText(join(home, ".agents/overlord/overlord.yaml"), "roots: []\n");
    await writeText(join(canonical, "SKILL.md"), namedSkill("critical"));

    const result = await synchronize(options);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "artifact-root-overlap",
      scopePath: home,
    }));
    await expect(lstat(join(claudeRoot, "skills/critical"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
