import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { nativeAt, sameCommonAgent, scanNative } from "../src/native.js";
import type { TargetPaths } from "../src/targets.js";
import type { CanonicalAgent } from "../src/types.js";
import { temporaryDirectory, writeText } from "./helpers.js";

function targetPaths(scope: string): TargetPaths {
  return {
    claude: {
      skills: join(scope, ".claude", "skills"),
      agents: join(scope, ".claude", "agents"),
    },
    codex: { agents: join(scope, ".codex", "agents") },
  };
}

function skillSource(name: string): string {
  return `---\nname: ${name}\ndescription: A portable native skill.\n---\n\nDo the work.\n`;
}

function claudeAgentSource(name: string): string {
  return `---\nname: ${name}\ndescription: A native Claude agent.\nmodel: opus\n---\n\nReview the work.\n`;
}

function codexAgentSource(name: string): string {
  return `name = "${name}"\ndescription = "A native Codex agent."\nmodel = "gpt-5"\ndeveloper_instructions = "Review the work.\\n"\n`;
}

describe("native inventory", () => {
  it.each(["synced", "Synced", "SYNCED", ".trash", ".TRASH"])(
    "leaves Claude-owned %s storage out of inventory, even with nested payloads",
    async (name) => {
      const scope = await temporaryDirectory();
      const paths = targetPaths(scope);
      const container = join(paths.claude.skills, name);
      await mkdir(container, { recursive: true });
      expect(await scanNative(paths)).toEqual([]);
      await writeText(join(container, "account-bucket/pdf/SKILL.md"), skillSource("pdf"));
      await writeText(join(container, "account-bucket/manifest.json"), "{}\n");
      await symlink("missing-target", join(container, "account-link"));
      await writeText(join(paths.claude.skills, "local", "SKILL.md"), skillSource("local"));
      await mkdir(join(paths.claude.skills, "malformed"));
      expect(await scanNative(paths)).toEqual([
        expect.objectContaining({ name: "local", valid: true }),
        expect.objectContaining({ name: "malformed", valid: false }),
      ]);
    },
  );

  it("scans only the supported Claude skills and Claude and Codex agents", async () => {
    const scope = await temporaryDirectory();
    const paths = targetPaths(scope);
    await writeText(join(paths.claude.skills, "verify-build", "SKILL.md"), skillSource("verify-build"));
    await writeText(join(paths.claude.agents, "reviewer.md"), claudeAgentSource("reviewer"));
    await writeText(join(paths.codex.agents, "builder.toml"), codexAgentSource("builder"));

    const inventory = await scanNative(paths);

    expect(inventory.map(({ kind, name, target, valid }) => ({ kind, name, target, valid }))).toEqual([
      { kind: "agent", name: "builder", target: "codex", valid: true },
      { kind: "agent", name: "reviewer", target: "claude", valid: true },
      { kind: "skill", name: "verify-build", target: "claude", valid: true },
    ]);
    const claudeAgent = inventory.find((entry) => entry.name === "reviewer");
    const codexAgent = inventory.find((entry) => entry.name === "builder");
    expect(claudeAgent?.source).toBe(claudeAgentSource("reviewer"));
    expect(claudeAgent?.agent?.targets.claude).toMatchObject({ model: "opus" });
    expect(codexAgent?.source).toBe(codexAgentSource("builder"));
    expect(codexAgent?.agent?.targets.codex).toMatchObject({ model: "gpt-5" });
    expect(nativeAt(inventory, join(paths.codex.agents, "builder.toml"))).toBe(codexAgent);
  });

  it("does not discover .codex/skills even when the surrounding scope is scanned", async () => {
    const scope = await temporaryDirectory();
    const paths = targetPaths(scope);
    await writeText(join(paths.claude.skills, "visible", "SKILL.md"), skillSource("visible"));
    await writeText(join(dirname(paths.codex.agents), "skills", "hidden", "SKILL.md"), skillSource("hidden"));

    const inventory = await scanNative(paths);

    expect(inventory.map((entry) => entry.name)).toEqual(["visible"]);
  });

  it("discovers Claude agents recursively while Codex agents remain immediate", async () => {
    const scope = await temporaryDirectory();
    const paths = targetPaths(scope);
    await writeText(join(paths.claude.agents, "review", "deep", "reviewer.md"), claudeAgentSource("reviewer"));
    await writeText(join(paths.codex.agents, "nested", "ignored.toml"), codexAgentSource("ignored"));

    const inventory = await scanNative(paths);

    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({ kind: "agent", name: "reviewer", target: "claude", valid: true });
  });

  it("marks definition symlinks invalid", async () => {
    const scope = await temporaryDirectory();
    const paths = targetPaths(scope);
    const source = join(scope, "source-skill");
    await writeText(join(source, "SKILL.md"), skillSource("linked-skill"));
    await mkdir(paths.claude.skills, { recursive: true });
    const linkedSkill = join(paths.claude.skills, "linked-skill");
    await symlink(source, linkedSkill);

    const inventory = await scanNative(paths);

    expect(inventory).toContainEqual(expect.objectContaining({
      kind: "skill",
      name: "linked-skill",
      target: "claude",
      path: linkedSkill,
      valid: false,
      evidence: "native skill must be a physical directory",
    }));
  });

  it("marks a skill with nested Git metadata invalid", async () => {
    const scope = await temporaryDirectory();
    const paths = targetPaths(scope);
    const skill = join(paths.claude.skills, "nested-repository");
    await writeText(join(skill, "SKILL.md"), skillSource("nested-repository"));
    await writeText(join(skill, ".git/config"), "[core]\n\trepositoryformatversion = 0\n");

    const inventory = await scanNative(paths);

    expect(inventory).toContainEqual(expect.objectContaining({
      kind: "skill",
      name: "nested-repository",
      valid: false,
      evidence: expect.stringMatching(/Git metadata/i),
    }));
  });

  it("requires existing artifact roots to be physical directories", async () => {
    const scope = await temporaryDirectory();
    const paths = targetPaths(scope);
    const physicalRoot = join(scope, "physical-skills");
    await mkdir(physicalRoot, { recursive: true });
    await mkdir(dirname(paths.claude.skills), { recursive: true });
    await symlink(physicalRoot, paths.claude.skills);

    await expect(scanNative(paths)).rejects.toMatchObject({
      code: "permission-denied",
      path: paths.claude.skills,
    });
  });

  it("ignores operating-system metadata and returns a deterministic order", async () => {
    const scope = await temporaryDirectory();
    const paths = targetPaths(scope);
    await writeText(join(paths.claude.skills, "middle", "SKILL.md"), skillSource("middle"));
    await writeText(join(paths.claude.skills, ".DS_Store"), "metadata");
    await writeText(join(paths.claude.agents, "zulu.md"), claudeAgentSource("zulu"));
    await writeText(join(paths.claude.agents, "nested", "alpha.md"), claudeAgentSource("alpha"));
    await writeText(join(paths.claude.agents, "._ghost.md"), "metadata");
    await writeText(join(paths.codex.agents, "alpha.toml"), codexAgentSource("alpha"));
    await writeText(join(paths.codex.agents, "._ghost.toml"), "metadata");

    const first = await scanNative(paths);
    const second = await scanNative(paths);
    const describeEntry = (entry: (typeof first)[number]): string => `${entry.kind}:${entry.name}:${entry.target}`;

    expect(first.map(describeEntry)).toEqual([
      "agent:alpha:claude",
      "agent:alpha:codex",
      "agent:zulu:claude",
      "skill:middle:claude",
    ]);
    expect(second.map((entry) => entry.path)).toEqual(first.map((entry) => entry.path));
  });
});

describe("sameCommonAgent", () => {
  const base: CanonicalAgent = {
    version: 1,
    name: "reviewer",
    description: "Reviews changes.",
    body: "Review carefully.\n",
    path: "/one/reviewer.md",
    valid: true,
    targets: { claude: { model: "opus" }, codex: false },
  };

  it("compares only normalized common agent fields", () => {
    const other: CanonicalAgent = {
      ...base,
      body: "Review carefully.\r\n\r\n",
      path: "/two/reviewer.toml",
      targets: { claude: false, codex: { model: "gpt-5" } },
    };

    expect(sameCommonAgent(base, other)).toBe(true);
    expect(sameCommonAgent(base, { ...other, description: "Different." })).toBe(false);
  });
});
