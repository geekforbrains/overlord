import { afterEach, describe, expect, it } from "vitest";
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { inspect, synchronize } from "../src/engine.js";
import { ledgerPath, physicalScopeIdentity } from "../src/ledger.js";
import type { EngineOptions } from "../src/types.js";
import { cleanupTemporaryDirectories, temporaryDirectory, validAgent, validSkill, writeText } from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

function namedSkill(body: string): string {
  return validSkill.replace("Run the documented build and report concrete failures.", body);
}

async function fixture() {
  const home = await temporaryDirectory();
  const root = await temporaryDirectory();
  const project = join(root, "project");
  const options: EngineOptions = {
    home,
    env: {
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
    },
  };
  await writeText(join(home, ".agents/overlord/overlord.yaml"), `roots:\n  - ${root}\n`);
  return { home, project, options };
}

describe("last-sync reconciliation", () => {
  it("propagates a canonical skill edit made after the baseline", async () => {
    const { project, options } = await fixture();
    const canonical = join(project, ".agents/skills/verify-build/SKILL.md");
    const claude = join(project, ".claude/skills/verify-build/SKILL.md");
    await writeText(canonical, namedSkill("Use the first workflow."));
    expect((await synchronize(options)).status).toBe("ok");

    await writeText(canonical, namedSkill("Use the revised canonical workflow."));
    const result = await synchronize(options);

    expect(result.status).toBe("ok");
    expect(await readFile(claude, "utf8")).toContain("revised canonical workflow");
    expect(result.definitions).toContainEqual(expect.objectContaining({
      kind: "skill",
      name: "verify-build",
      scopePath: project,
      state: "synced",
    }));
  });

  it("imports a Claude skill edit into the same project canonical source", async () => {
    const { project, options } = await fixture();
    const canonical = join(project, ".agents/skills/verify-build/SKILL.md");
    const claude = join(project, ".claude/skills/verify-build/SKILL.md");
    await writeText(canonical, namedSkill("Use the first workflow."));
    expect((await synchronize(options)).status).toBe("ok");

    await writeText(claude, namedSkill("Use the Claude-authored revision."));
    const result = await synchronize(options);

    expect(result.status).toBe("ok");
    expect(await readFile(canonical, "utf8")).toContain("Claude-authored revision");
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "completed", reads: [join(project, ".claude/skills/verify-build")] }),
    ]));
  });

  it("leaves incompatible canonical and Claude edits untouched", async () => {
    const { project, options } = await fixture();
    const canonical = join(project, ".agents/skills/verify-build/SKILL.md");
    const claude = join(project, ".claude/skills/verify-build/SKILL.md");
    await writeText(canonical, namedSkill("Use the first workflow."));
    expect((await synchronize(options)).status).toBe("ok");

    const canonicalEdit = namedSkill("Use the canonical revision.");
    const claudeEdit = namedSkill("Use the Claude revision.");
    await writeText(canonical, canonicalEdit);
    await writeText(claude, claudeEdit);
    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({
      kind: "skill",
      name: "verify-build",
      scopePath: project,
      state: "conflict",
    }));
    expect(await readFile(canonical, "utf8")).toBe(canonicalEdit);
    expect(await readFile(claude, "utf8")).toBe(claudeEdit);
  });

  it("propagates a tracked canonical skill deletion", async () => {
    const { project, options } = await fixture();
    const canonical = join(project, ".agents/skills/verify-build");
    const claude = join(project, ".claude/skills/verify-build");
    await writeText(join(canonical, "SKILL.md"), validSkill);
    expect((await synchronize(options)).status).toBe("ok");

    await rm(canonical, { recursive: true });
    const result = await synchronize(options);

    expect(result.status).toBe("ok");
    await expect(lstat(claude)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "completed", removes: [claude] }),
    ]));
  });

  it("propagates a tracked Claude skill deletion", async () => {
    const { project, options } = await fixture();
    const canonical = join(project, ".agents/skills/verify-build");
    const claude = join(project, ".claude/skills/verify-build");
    await writeText(join(canonical, "SKILL.md"), validSkill);
    expect((await synchronize(options)).status).toBe("ok");

    await rm(claude, { recursive: true });
    const result = await synchronize(options);

    expect(result.status).toBe("ok");
    await expect(lstat(canonical)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports deletion versus modification as a conflict", async () => {
    const { project, options } = await fixture();
    const canonical = join(project, ".agents/skills/verify-build");
    const claude = join(project, ".claude/skills/verify-build/SKILL.md");
    await writeText(join(canonical, "SKILL.md"), validSkill);
    expect((await synchronize(options)).status).toBe("ok");

    await rm(canonical, { recursive: true });
    await writeText(claude, namedSkill("Keep this provider revision."));
    const result = await synchronize(options);

    expect(result.status).toBe("attention-required");
    expect(result.definitions).toContainEqual(expect.objectContaining({ state: "conflict" }));
    expect(await readFile(claude, "utf8")).toContain("Keep this provider revision");
  });

  it("imports a Codex agent edit and updates the canonical and Claude forms", async () => {
    const { project, options } = await fixture();
    const canonical = join(project, ".agents/overlord/agents/reviewer.md");
    const claude = join(project, ".claude/agents/reviewer.md");
    const codex = join(project, ".codex/agents/reviewer.toml");
    await writeText(canonical, validAgent);
    expect((await synchronize(options)).status).toBe("ok");

    const codexSource = (await readFile(codex, "utf8")).replace(
      "Reviews a change for correctness and missing tests.",
      "Reviews the revised system carefully.",
    );
    await writeText(codex, codexSource);
    const result = await synchronize(options);

    expect(result.status).toBe("ok");
    expect(await readFile(canonical, "utf8")).toContain("Reviews the revised system carefully.");
    expect(await readFile(claude, "utf8")).toContain("Reviews the revised system carefully.");
  });

  it("does not create or update the ledger during status", async () => {
    const { home, project, options } = await fixture();
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    const ledger = ledgerPath(join(home, ".agents"), await physicalScopeIdentity(project));

    await inspect(options);

    await expect(lstat(ledger)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
