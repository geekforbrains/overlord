import { afterEach, describe, expect, it } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTemporaryDirectories, temporaryDirectory, validAgent, validSkill, writeText } from "./helpers.js";
import { loadCanonicalScope } from "../src/definitions.js";

afterEach(cleanupTemporaryDirectories);

describe("canonical definitions", () => {
  it.each(["synced", "Synced", "SYNCED", ".trash", ".TRASH"])(
    "rejects canonical skills colliding with Claude-owned %s storage",
    async (name) => {
      const root = await temporaryDirectory();
      const path = join(root, ".agents/skills", name);
      await writeText(join(path, "SKILL.md"), validSkill.replace("verify-build", name));
      const loaded = await loadCanonicalScope(join(root, ".agents"));
      expect(loaded.skills).toContainEqual({ name, path, valid: false });
      expect(loaded.diagnostics).toContainEqual(expect.objectContaining({
        code: "reserved-claude-skill-name", severity: "error", path,
      }));
    },
  );

  it("loads a standard skill without changing its files", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, ".agents/skills/verify-build");
    await writeText(join(skill, "SKILL.md"), validSkill);
    await writeText(join(skill, "scripts/check.sh"), "#!/bin/sh\nexit 0\n", 0o755);

    const loaded = await loadCanonicalScope(join(root, ".agents"));
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.skills[0]).toMatchObject({ name: "verify-build", path: skill, valid: true });
    expect(loaded.diagnostics).toEqual([]);
  });

  it.each(["UPPER", "-leading", "trailing-", "double--dash", "name_with_underscore"])(
    "rejects non-portable skill name %s",
    async (name) => {
      const root = await temporaryDirectory();
      await writeText(join(root, `.agents/skills/${name}/SKILL.md`), validSkill.replace("name: verify-build", `name: ${name}`));
      const loaded = await loadCanonicalScope(join(root, ".agents"));
      expect(loaded.skills[0]?.valid).toBe(false);
      expect(loaded.diagnostics.some((entry) => entry.code === "non-portable-name")).toBe(true);
    },
  );

  it("requires the skill directory to equal its frontmatter name", async () => {
    const root = await temporaryDirectory();
    await writeText(join(root, ".agents/skills/wrong/SKILL.md"), validSkill);
    const loaded = await loadCanonicalScope(join(root, ".agents"));
    expect(loaded.skills[0]?.valid).toBe(false);
    expect(loaded.diagnostics[0]?.message).toContain("directory name");
  });

  it("loads canonical agents and warns while passing through unknown overlay fields", async () => {
    const root = await temporaryDirectory();
    await writeText(join(root, ".agents/overlord/agents/reviewer.md"), validAgent.replace("tools:", "tols:"));
    const loaded = await loadCanonicalScope(join(root, ".agents"));
    expect(loaded.agents[0]).toMatchObject({ name: "reviewer", valid: true });
    expect(loaded.diagnostics[0]).toMatchObject({ code: "unknown-overlay-field", severity: "warning", suggestion: "tools" });
  });

  it("rejects target enablement values other than a mapping or false", async () => {
    const root = await temporaryDirectory();
    await writeText(
      join(root, ".agents/overlord/agents/reviewer.md"),
      validAgent.replace(
        "  claude:\n    color: cyan\n    model: opus\n    tools: [Read, Grep, Glob]\n",
        "  claude: true\n",
      ),
    );

    const loaded = await loadCanonicalScope(join(root, ".agents"));

    expect(loaded.agents[0]?.valid).toBe(false);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({
      code: "invalid-target-overlay",
      severity: "error",
    }));
  });

  it("rejects agent file/name mismatches and digits", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".agents/overlord/agents"), { recursive: true });
    await writeFile(join(root, ".agents/overlord/agents/reviewer.md"), validAgent.replace("name: reviewer", "name: reviewer2"));
    const loaded = await loadCanonicalScope(join(root, ".agents"));
    expect(loaded.agents[0]?.valid).toBe(false);
    expect(loaded.diagnostics.some((entry) => entry.code === "non-portable-name")).toBe(true);
  });

  it("enforces the Agent Skills description limit", async () => {
    const root = await temporaryDirectory();
    await writeText(
      join(root, ".agents/skills/verify-build/SKILL.md"),
      validSkill.replace(
        "Verify a build using the project-specific launch recipe.",
        "x".repeat(1_025),
      ),
    );
    const loaded = await loadCanonicalScope(join(root, ".agents"));
    expect(loaded.skills[0]?.valid).toBe(false);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "field-too-long" }));
  });

  it("rejects skill symlinks that escape the skill directory", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, ".agents/skills/verify-build");
    await writeText(join(skill, "SKILL.md"), validSkill);
    await writeText(join(root, "secret.txt"), "not portable\n");
    await symlink(join(root, "secret.txt"), join(skill, "secret.txt"));
    const loaded = await loadCanonicalScope(join(root, ".agents"));
    expect(loaded.skills[0]?.valid).toBe(false);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "unsupported-skill-symlink" }));
  });

  it("rejects skill symlinks even when they stay inside the skill directory", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, ".agents/skills/verify-build");
    await writeText(join(skill, "SKILL.md"), validSkill);
    await writeText(join(skill, "references/source.md"), "source\n");
    await symlink("source.md", join(skill, "references/current.md"));

    const loaded = await loadCanonicalScope(join(root, ".agents"));

    expect(loaded.skills[0]?.valid).toBe(false);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "unsupported-skill-symlink" }));
  });

  it.each([".git", ".GIT"])(
    "rejects nested Git metadata %s that the source repository cannot version as skill files",
    async (metadataName) => {
      const root = await temporaryDirectory();
      const skill = join(root, ".agents/skills/verify-build");
      await writeText(join(skill, "SKILL.md"), validSkill);
      await writeText(join(skill, metadataName, "config"), "[core]\n\trepositoryformatversion = 0\n");

      const loaded = await loadCanonicalScope(join(root, ".agents"));

      expect(loaded.skills[0]?.valid).toBe(false);
      expect(loaded.diagnostics).toContainEqual(expect.objectContaining({
        code: "unsupported-skill-git-metadata",
        path: join(skill, metadataName),
      }));
    },
  );

  it("rejects an internal symlink chain that physically escapes the skill", async () => {
    const root = await temporaryDirectory();
    const skills = join(root, ".agents/skills");
    const escape = join(skills, "escape");
    await writeText(join(escape, "SKILL.md"), validSkill.replaceAll("verify-build", "escape"));
    await writeText(join(skills, "secret/SKILL.md"), validSkill.replaceAll("verify-build", "secret"));
    await symlink(".", join(escape, "pivot"));
    await symlink("pivot/../secret/SKILL.md", join(escape, "leak"));

    const loaded = await loadCanonicalScope(join(root, ".agents"));

    expect(loaded.skills).toContainEqual(expect.objectContaining({ name: "escape", valid: false }));
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "unsupported-skill-symlink" }));
  });

  it("reports top-level canonical definition symlinks instead of silently ignoring them", async () => {
    const root = await temporaryDirectory();
    const linkedSkill = join(root, "linked-skill");
    const linkedAgent = join(root, "linked-agent.md");
    await writeText(join(linkedSkill, "SKILL.md"), validSkill.replaceAll("verify-build", "linked"));
    await writeText(linkedAgent, validAgent);
    await mkdir(join(root, ".agents/skills"), { recursive: true });
    await mkdir(join(root, ".agents/overlord/agents"), { recursive: true });
    await symlink(linkedSkill, join(root, ".agents/skills/linked"));
    await symlink(linkedAgent, join(root, ".agents/overlord/agents/reviewer.md"));

    const loaded = await loadCanonicalScope(join(root, ".agents"));
    expect(loaded.skills).toContainEqual(expect.objectContaining({ name: "linked", valid: false }));
    expect(loaded.agents).toContainEqual(expect.objectContaining({ name: "reviewer", valid: false }));
    expect(loaded.diagnostics.filter((entry) => entry.code === "unsupported-canonical-symlink")).toHaveLength(2);
  });

  it("reports unsupported canonical definition entry types", async () => {
    const root = await temporaryDirectory();
    await writeText(join(root, ".agents/skills/broken"), "not a skill directory\n");
    await mkdir(join(root, ".agents/overlord/agents/broken.md"), { recursive: true });

    const loaded = await loadCanonicalScope(join(root, ".agents"));

    expect(loaded.skills).toContainEqual(expect.objectContaining({ name: "broken", valid: false }));
    expect(loaded.agents).toContainEqual(expect.objectContaining({ name: "broken", valid: false }));
    expect(loaded.diagnostics.filter((entry) => entry.severity === "error").length).toBeGreaterThanOrEqual(2);
  });

  it("reports a canonical agent with a case-aliased Markdown extension", async () => {
    const root = await temporaryDirectory();
    await writeText(join(root, ".agents/overlord/agents/reviewer.MD"), validAgent);

    const loaded = await loadCanonicalScope(join(root, ".agents"));

    expect(loaded.agents).toContainEqual(expect.objectContaining({ name: "reviewer", valid: false }));
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "non-portable-agent-extension" }));
  });
});
