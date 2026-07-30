import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTemporaryDirectories, temporaryDirectory, validAgent, validSkill, writeText } from "./helpers.js";
import { loadCanonicalScope } from "../src/definitions.js";

afterEach(cleanupTemporaryDirectories);

describe("canonical definitions", () => {
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

  it("ignores operating-system artifacts while retaining ordinary dotfiles", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, ".agents/skills/verify-build");
    await writeText(join(skill, "SKILL.md"), validSkill);
    await writeText(join(skill, ".DS_Store"), "noise");
    await writeText(join(skill, ".env.example"), "SAFE=true\n");
    const loaded = await loadCanonicalScope(join(root, ".agents"));
    expect(loaded.skills[0]?.files.map((file) => file.relativePath)).toContain(".env.example");
    expect(loaded.skills[0]?.files.map((file) => file.relativePath)).not.toContain(".DS_Store");
  });

  it("loads canonical agents and warns while passing through unknown overlay fields", async () => {
    const root = await temporaryDirectory();
    await writeText(join(root, ".agents/overlord/agents/reviewer.md"), validAgent.replace("tools:", "tols:"));
    const loaded = await loadCanonicalScope(join(root, ".agents"));
    expect(loaded.agents[0]).toMatchObject({ name: "reviewer", valid: true });
    expect(loaded.diagnostics[0]).toMatchObject({ code: "unknown-overlay-field", severity: "warning", suggestion: "tools" });
  });

  it("promotes unknown overlay fields to invalid in strict mode", async () => {
    const root = await temporaryDirectory();
    await writeText(join(root, ".agents/overlord/agents/reviewer.md"), validAgent.replace("tools:", "tols:"));
    const loaded = await loadCanonicalScope(join(root, ".agents"), { strict: true });
    expect(loaded.agents[0]?.valid).toBe(false);
    expect(loaded.diagnostics[0]?.severity).toBe("error");
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

  it("preserves executable mode in its skill inventory", async () => {
    const root = await temporaryDirectory();
    const path = join(root, ".agents/skills/verify-build/scripts/check.sh");
    await writeText(join(root, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await writeText(path, "#!/bin/sh\n", 0o644);
    await chmod(path, 0o751);
    const loaded = await loadCanonicalScope(join(root, ".agents"));
    expect(loaded.skills[0]?.files.find((file) => file.relativePath === "scripts/check.sh")?.mode).toBe(0o751);
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
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ code: "unsafe-symlink" }));
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
});
