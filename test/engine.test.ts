import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdir, readFile, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

import { initialize, synchronize } from "../src/engine.js";
import { acquireScopeLock } from "../src/filesystem.js";
import { cleanupTemporaryDirectories, prepareUserRepository, temporaryDirectory, validAgent, validSkill, writeText } from "./helpers.js";
import type { EngineOptions } from "../src/types.js";

afterEach(cleanupTemporaryDirectories);

function namedSkill(name: string, body = "Run the documented build and report concrete failures."): string {
  return validSkill.replaceAll("verify-build", name).replace(
    "Run the documented build and report concrete failures.",
    body,
  );
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

describe("fleet inventory and synchronization", () => {
  it("initializes the user source and bundled skill idempotently", async () => {
    const home = await temporaryDirectory();
    const options: EngineOptions = { home, env: {} };

    const first = await initialize(options);

    expect(first.status).toBe("ok");
    expect(await readFile(join(home, ".agents/overlord/overlord.yaml"), "utf8")).toBe("roots: []\n");
    expect(await readFile(join(home, ".agents/skills/overlord/SKILL.md"), "utf8")).toContain("name: overlord");

    const second = await initialize(options);
    expect(second.status).toBe("ok");
    expect(second.actions).toEqual([]);
  });

  it("reports only init work completed before a later failure", async () => {
    const home = await temporaryDirectory();
    const options: EngineOptions = { home, env: {} };
    await writeText(join(home, ".agents/overlord/overlord.yaml"), "roots: []\n");
    await writeText(join(home, ".agents/overlord/agents"), "blocks the agents directory\n");

    let failure: unknown;
    try {
      await initialize(options);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as { completedActions?: unknown }).completedActions).toEqual([
      expect.objectContaining({
        status: "completed",
        writes: [join(home, ".agents/skills")],
      }),
    ]);
  });

  it("reports init work completed before bundled-skill verification fails", async () => {
    const home = await temporaryDirectory();
    const options: EngineOptions = { home, env: {} };
    await mkdir(join(home, ".agents/skills/overlord/SKILL.md"), { recursive: true });

    let failure: unknown;
    try {
      await initialize(options);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const actions = (failure as { completedActions?: Array<{ writes?: string[] }> }).completedActions ?? [];
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ writes: [join(home, ".agents/overlord/agents")] }),
      expect.objectContaining({ writes: [join(home, ".agents/overlord/overlord.yaml")] }),
    ]));
  });

  it("copies canonical skills byte-for-byte, preserves modes, and becomes idempotent", async () => {
    const { discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "app");
    const source = join(project, ".agents/skills/verify-build");
    const destination = join(project, ".claude/skills/verify-build");
    await writeText(join(source, "SKILL.md"), validSkill);
    await writeText(join(source, "scripts/check.sh"), "#!/bin/sh\nexit 0\n", 0o751);

    const first = await synchronize(options);

    expect(first.status).toBe("ok");
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe(validSkill);
    expect((await lstat(join(destination, "scripts/check.sh"))).mode & 0o777).toBe(0o751);
    const before = (await lstat(join(destination, "SKILL.md"))).mtimeMs;

    const second = await synchronize(options);
    expect(second.actions).toEqual([]);
    expect((await lstat(join(destination, "SKILL.md"))).mtimeMs).toBe(before);
  });

  it("renders one canonical agent to both native formats", async () => {
    const { discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "app");
    await writeText(join(project, ".agents/overlord/agents/reviewer.md"), validAgent);

    const result = await synchronize(options);

    const claude = await readFile(join(project, ".claude/agents/reviewer.md"), "utf8");
    const codex = parseToml(await readFile(join(project, ".codex/agents/reviewer.toml"), "utf8"));
    expect(result.status).toBe("ok");
    expect(claude).toContain("color: cyan");
    expect(codex).toMatchObject({
      name: "reviewer",
      sandbox_mode: "read-only",
      developer_instructions: expect.stringContaining("Review the requested change"),
    });
    expect(result.definitions).toContainEqual(expect.objectContaining({
      name: "reviewer",
      scopePath: project,
      state: "synced",
    }));
  });

  it("does not create or report an output for a disabled agent target", async () => {
    const { discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "app");
    await writeText(
      join(project, ".agents/overlord/agents/reviewer.md"),
      validAgent.replace(
        "  claude:\n    color: cyan\n    model: opus\n    tools: [Read, Grep, Glob]\n",
        "  claude: false\n",
      ),
    );

    const result = await synchronize(options);
    const definition = result.definitions?.find((entry) => entry.scopePath === project && entry.name === "reviewer");

    expect(result.status).toBe("ok");
    expect(definition?.outputs.map((output) => output.target)).toEqual(["codex"]);
    await expect(lstat(join(project, ".claude/agents/reviewer.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(project, ".codex/agents/reviewer.toml"), "utf8")).toContain('name = "reviewer"');
  });

  it("blocks every write in a scope containing an invalid canonical definition", async () => {
    const { discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "broken");
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await writeText(
      join(project, ".agents/overlord/agents/reviewer.md"),
      validAgent.replace(
        "  claude:\n    color: cyan\n    model: opus\n    tools: [Read, Grep, Glob]\n",
        "  claude: true\n",
      ),
    );

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({
      scopePath: project,
      name: "reviewer",
      state: "invalid",
    }));
    await expect(lstat(join(project, ".claude/skills/verify-build"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(project, ".claude/agents/reviewer.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(project, ".codex/agents/reviewer.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preflights every destination before writing an earlier missing output", async () => {
    const { discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "blocked-destination");
    const alphaOutput = join(project, ".codex/agents/alpha.toml");
    const occupied = join(project, ".codex/agents/beta.toml");
    await writeText(join(project, ".agents/overlord/agents/alpha.md"), codexOnlyAgent("alpha"));
    await writeText(join(project, ".agents/overlord/agents/beta.md"), codexOnlyAgent("beta"));
    await mkdir(occupied, { recursive: true });

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({
      scopePath: project,
      name: "beta",
      state: "invalid",
    }));
    await expect(lstat(alphaOutput)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(occupied)).isDirectory()).toBe(true);
  });

  it("reports conflicts without overwriting canonical or native content", async () => {
    const { discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "conflict");
    const canonicalPath = join(project, ".agents/skills/verify-build/SKILL.md");
    const nativePath = join(project, ".claude/skills/verify-build/SKILL.md");
    const nativeSkill = validSkill.replace("Run the documented build", "Run a different build");
    await writeText(canonicalPath, validSkill);
    await writeText(nativePath, nativeSkill);

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({
      scopePath: project,
      name: "verify-build",
      state: "conflict",
    }));
    expect(await readFile(canonicalPath, "utf8")).toBe(validSkill);
    expect(await readFile(nativePath, "utf8")).toBe(nativeSkill);
  });

  it("imports a unique Claude skill", async () => {
    const { discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "claude-native");
    const native = join(project, ".claude/skills/verify-build/SKILL.md");
    const canonical = join(project, ".agents/skills/verify-build/SKILL.md");
    await writeText(native, validSkill);

    const result = await synchronize(options);

    expect(result.status).toBe("ok");
    expect(await readFile(canonical, "utf8")).toBe(validSkill);
    expect(await readFile(native, "utf8")).toBe(validSkill);
    expect(result.definitions).toContainEqual(expect.objectContaining({
      scopePath: project,
      name: "verify-build",
      state: "synced",
    }));
  });

  it("imports a native agent while preserving its provider overlay", async () => {
    const { discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "native-agent");
    const native = `---
name: reviewer
description: Reviews changes.
model: opus
color: blue
---

Review carefully.
`;
    await writeText(join(project, ".claude/agents/reviewer.md"), native);

    const result = await synchronize(options);

    const canonical = await readFile(join(project, ".agents/overlord/agents/reviewer.md"), "utf8");
    expect(result.status).toBe("ok");
    expect(canonical).toContain("model: opus");
    expect(canonical).toContain("color: blue");
    expect(canonical).toContain("codex: {}");
    expect(await readFile(join(project, ".codex/agents/reviewer.toml"), "utf8")).toContain('name = "reviewer"');
  });

  it("does not hide a Claude skill named .system", async () => {
    const { discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "claude-system-skill");
    await writeText(
      join(project, ".claude/skills/.system/SKILL.md"),
      namedSkill("internal"),
    );

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({
      scopePath: project,
      name: ".system",
      state: "invalid",
    }));
  });

  it("reports a native agent with a case-aliased extension", async () => {
    const { discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "native-extension");
    await writeText(
      join(project, ".claude/agents/reviewer.MD"),
      `---\nname: reviewer\ndescription: Reviews changes.\n---\n\nReview carefully.\n`,
    );

    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({
      kind: "agent",
      name: "reviewer",
      scopePath: project,
      state: "invalid",
    }));
    await expect(lstat(join(project, ".agents/overlord/agents/reviewer.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects and preserves native skill symlinks, including links to canonical source", async () => {
    const { discoveryRoot, options } = await fixture();
    const project = join(discoveryRoot, "symlinks");
    const canonical = join(project, ".agents/skills/verify-build");
    const native = join(project, ".claude/skills/verify-build");
    await writeText(join(canonical, "SKILL.md"), validSkill);
    await mkdir(join(native, ".."), { recursive: true });
    await symlink(canonical, native);

    const linked = await synchronize(options);

    expect(linked.status).toBe("attention-required");
    expect(await readlink(native)).toBe(canonical);
    expect(linked.definitions).toContainEqual(expect.objectContaining({
      scopePath: project,
      name: "verify-build",
      state: "invalid",
    }));

    const dangling = join(project, ".claude/skills/dangling");
    await symlink(join(project, "missing"), dangling);
    const invalid = await synchronize(options);
    expect(invalid.status).toBe("attention-required");
    expect(invalid.definitions).toContainEqual(expect.objectContaining({
      scopePath: project,
      name: "dangling",
      state: "invalid",
    }));
    expect(await readlink(dangling)).toBe(join(project, "missing"));
  });

  it("reports one locked scope while continuing to synchronize a healthy sibling", async () => {
    const { discoveryRoot, options } = await fixture();
    const locked = join(discoveryRoot, "alpha-locked");
    const healthy = join(discoveryRoot, "zulu-healthy");
    await writeText(join(locked, ".agents/skills/locked-skill/SKILL.md"), namedSkill("locked-skill"));
    await writeText(join(healthy, ".agents/skills/healthy-skill/SKILL.md"), namedSkill("healthy-skill"));
    const release = await acquireScopeLock(locked);

    let result;
    try {
      result = await synchronize(options);
    } finally {
      await release();
    }

    expect(result.status).toBe("attention-required");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "lock-held",
      severity: "error",
      scopePath: locked,
    }));
    await expect(lstat(join(locked, ".claude/skills/locked-skill"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(healthy, ".claude/skills/healthy-skill/SKILL.md"), "utf8")).toContain("name: healthy-skill");
  });

  it("treats same-named user and project definitions as independent scopes", async () => {
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
});
