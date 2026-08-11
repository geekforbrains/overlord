import { afterEach, describe, expect, it } from "vitest";
import { lstat, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";

import { inspect, synchronize } from "../src/engine.js";
import { cleanupTemporaryDirectories, prepareUserRepository, temporaryDirectory, validAgent, validSkill, writeText } from "./helpers.js";
import type { EngineOptions } from "../src/types.js";

afterEach(cleanupTemporaryDirectories);

function namedSkill(name: string, body = "Run the shared workflow."): string {
  return validSkill
    .replaceAll("verify-build", name)
    .replace("Run the documented build and report concrete failures.", body);
}

function namedAgent(name: string): string {
  return validAgent
    .replace("name: reviewer", `name: ${name}`)
    .replace("Reviews a change", `Performs the ${name} review`);
}

async function fixture() {
  const home = await temporaryDirectory();
  const discoveryRoot = await temporaryDirectory();
  const options: EngineOptions = {
    home,
    env: {
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
    },
  };
  await writeText(
    join(home, ".agents/overlord/overlord.yaml"),
    `roots:\n  - ${discoveryRoot}\n`,
  );
  await prepareUserRepository(home);
  return { home, discoveryRoot, options };
}

describe("fleet synchronization", () => {
  it("synchronizes user and recursively discovered project scopes without hoisting", async () => {
    const { home, discoveryRoot, options } = await fixture();
    const alpha = join(discoveryRoot, "team/alpha");
    const bravo = join(discoveryRoot, "bravo");
    await writeText(join(home, ".agents/skills/user-skill/SKILL.md"), namedSkill("user-skill"));
    await writeText(join(alpha, ".agents/skills/project-skill/SKILL.md"), namedSkill("project-skill"));
    await writeText(join(bravo, ".agents/overlord/agents/reviewer.md"), validAgent);

    const preview = await inspect(options);
    const first = await synchronize(options);

    expect(preview.actions?.every((action) => action.status === "planned")).toBe(true);
    expect(first.status).toBe("ok");
    expect(first.actions?.every((action) => action.status === "completed")).toBe(true);
    expect(first.scopes?.map((scope) => scope.path)).toEqual([home, bravo, alpha]);
    expect(await readFile(join(home, ".claude/skills/user-skill/SKILL.md"), "utf8")).toContain("name: user-skill");
    expect(await readFile(join(alpha, ".claude/skills/project-skill/SKILL.md"), "utf8")).toContain("name: project-skill");
    expect(await readFile(join(bravo, ".claude/agents/reviewer.md"), "utf8")).toContain("name: reviewer");
    expect(await readFile(join(bravo, ".codex/agents/reviewer.toml"), "utf8")).toContain('name = "reviewer"');
    await expect(lstat(join(discoveryRoot, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });

    const second = await synchronize(options);
    expect(second.status).toBe("ok");
    expect(second.actions).toEqual([]);
  });

  it("imports unique native definitions into their own project", async () => {
    const { discoveryRoot, options } = await fixture();
    const skillProject = join(discoveryRoot, "native-skill");
    const agentProject = join(discoveryRoot, "nested/native-agent");
    await writeText(join(skillProject, ".claude/skills/provider-skill/SKILL.md"), namedSkill("provider-skill"));
    await writeText(
      join(agentProject, ".claude/agents/auditor.md"),
      `---\nname: auditor\ndescription: Audits changes.\nmodel: opus\n---\n\nAudit carefully.\n`,
    );

    const result = await synchronize(options);

    expect(result.status).toBe("ok");
    expect(await readFile(join(skillProject, ".agents/skills/provider-skill/SKILL.md"), "utf8")).toContain("name: provider-skill");
    expect(await readFile(join(agentProject, ".agents/overlord/agents/auditor.md"), "utf8")).toContain("name: auditor");
    expect(await readFile(join(agentProject, ".codex/agents/auditor.toml"), "utf8")).toContain('name = "auditor"');
  });

  it("reports conflicts without overwriting either side", async () => {
    const { discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "conflict");
    const canonical = namedSkill("shared-skill", "Use the canonical workflow.");
    const native = namedSkill("shared-skill", "Use the Claude-only workflow.");
    await writeText(join(project, ".agents/skills/shared-skill/SKILL.md"), canonical);
    await writeText(join(project, ".claude/skills/shared-skill/SKILL.md"), native);

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({
      name: "shared-skill",
      scopePath: project,
      state: "conflict",
    }));
    expect(await readFile(join(project, ".agents/skills/shared-skill/SKILL.md"), "utf8")).toBe(canonical);
    expect(await readFile(join(project, ".claude/skills/shared-skill/SKILL.md"), "utf8")).toBe(native);
  });

  it("isolates invalid scopes while synchronizing healthy siblings", async () => {
    const { discoveryRoot, options } = await fixture();
    const broken = join(discoveryRoot, "broken");
    const healthy = join(discoveryRoot, "healthy");
    await writeText(
      join(broken, ".agents/overlord/agents/BAD.md"),
      namedAgent("auditor").replace("name: auditor", "name: BAD"),
    );
    await writeText(join(healthy, ".agents/skills/healthy-skill/SKILL.md"), namedSkill("healthy-skill"));

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({ scopePath: broken, state: "invalid" }));
    expect(await readFile(join(healthy, ".claude/skills/healthy-skill/SKILL.md"), "utf8")).toContain("name: healthy-skill");
    await expect(lstat(join(broken, ".claude/agents/BAD.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats the same name in user and project scopes independently", async () => {
    const { home, discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "app");
    await writeText(join(home, ".agents/skills/shared/SKILL.md"), namedSkill("shared", "Use the user workflow."));
    await writeText(join(project, ".agents/skills/shared/SKILL.md"), namedSkill("shared", "Use the project workflow."));

    const result = await synchronize(options);

    expect(result.status).toBe("ok");
    expect(result.definitions?.filter((definition) => definition.name === "shared")).toHaveLength(2);
    expect(await readFile(join(home, ".claude/skills/shared/SKILL.md"), "utf8")).toContain("Use the user workflow.");
    expect(await readFile(join(project, ".claude/skills/shared/SKILL.md"), "utf8")).toContain("Use the project workflow.");
  });

  it("reports discovery-root failures as fleet issues", async () => {
    const home = await temporaryDirectory();
    const missing = join(home, "missing-root");
    const options: EngineOptions = { home, env: {} };
    await writeText(
      join(home, ".agents/overlord/overlord.yaml"),
      `roots:\n  - ${missing}\n`,
    );
    await prepareUserRepository(home);

    const result = await inspect(options);

    expect(result.status).toBe("attention-required");
    expect(result.scopes?.map((scope) => scope.path)).toEqual([home]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: "error", path: missing }));
  });

  it("does not rediscover user-native directories inside a configured root as projects", async () => {
    const home = await temporaryDirectory();
    const discoveryRoot = await temporaryDirectory();
    const userClaudeRoot = join(discoveryRoot, "user-native/.claude");
    const options: EngineOptions = {
      home,
      env: { CLAUDE_CONFIG_DIR: userClaudeRoot, CODEX_HOME: join(home, ".codex") },
    };
    await writeText(
      join(home, ".agents/overlord/overlord.yaml"),
      `roots:\n  - ${discoveryRoot}\n`,
    );
    await prepareUserRepository(home);
    await writeText(join(home, ".agents/skills/user-skill/SKILL.md"), namedSkill("user-skill"));

    const synced = await synchronize(options);
    const inspected = await inspect(options);

    expect(synced.status).toBe("attention-required");
    expect(inspected.scopes?.map((scope) => scope.path)).toEqual([home]);
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({
      code: "user-target-overlaps-project",
      scopePath: home,
    }));
    await expect(lstat(join(userClaudeRoot, "skills/user-skill"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(discoveryRoot, "user-native/.agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks a user target below a discovery root reached through a symlink alias", async () => {
    const home = await temporaryDirectory();
    const discoveryRoot = await temporaryDirectory();
    const aliasParent = await temporaryDirectory();
    const aliasRoot = join(aliasParent, "root-alias");
    await symlink(discoveryRoot, aliasRoot);
    const userClaudeRoot = join(aliasRoot, "app/.claude");
    const options: EngineOptions = {
      home,
      env: { CLAUDE_CONFIG_DIR: userClaudeRoot, CODEX_HOME: join(home, ".codex") },
    };
    await writeText(
      join(home, ".agents/overlord/overlord.yaml"),
      `roots:\n  - ${discoveryRoot}\n`,
    );
    await prepareUserRepository(home);
    await writeText(join(home, ".agents/skills/user-skill/SKILL.md"), namedSkill("user-skill"));

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "user-target-overlaps-project",
      scopePath: home,
    }));
    await expect(lstat(join(discoveryRoot, "app/.claude/skills/user-skill"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks user target paths that overlap a project's canonical source", async () => {
    const home = await temporaryDirectory();
    const discoveryRoot = await temporaryDirectory();
    const project = join(discoveryRoot, "app");
    const options: EngineOptions = {
      home,
      env: { CLAUDE_CONFIG_DIR: join(project, ".agents"), CODEX_HOME: join(home, ".codex") },
    };
    await writeText(
      join(home, ".agents/overlord/overlord.yaml"),
      `roots:\n  - ${discoveryRoot}\n`,
    );
    await prepareUserRepository(home);
    await writeText(join(home, ".agents/skills/user-skill/SKILL.md"), namedSkill("user-skill"));
    await writeText(join(project, ".agents/skills/project-skill/SKILL.md"), namedSkill("project-skill"));

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "user-target-overlaps-project", scopePath: home }),
      expect.objectContaining({ code: "user-target-overlaps-project", scopePath: project }),
    ]));
    await expect(lstat(join(home, ".agents/skills/project-skill"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(project, ".agents/skills/user-skill"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
