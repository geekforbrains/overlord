import { afterEach, describe, expect, it } from "vitest";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

import { discoverScopes } from "../src/discovery.js";
import { cleanupTemporaryDirectories, temporaryDirectory, validAgent, validSkill, writeText } from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

function scopePaths(scopes: Awaited<ReturnType<typeof discoverScopes>>["scopes"]): string[] {
  return scopes.map((scope) => scope.path);
}

describe("scope discovery", () => {
  it("always returns the user scope first", async () => {
    const home = await temporaryDirectory();
    const root = join(home, "Projects");
    const project = join(root, "app");
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);

    const result = await discoverScopes({ home, roots: [root] });

    expect(result.diagnostics).toEqual([]);
    expect(result.scopes[0]).toEqual({
      type: "user",
      path: home,
      canonical: join(home, ".agents"),
    });
    expect(result.scopes[1]).toMatchObject({
      type: "project",
      path: project,
      canonical: join(project, ".agents"),
    });
  });

  it("recursively discovers canonical and provider-native skill and agent scopes", async () => {
    const home = await temporaryDirectory();
    const root = join(home, "Projects");
    const projects = [
      join(root, "group/alpha"),
      join(root, "group/bravo"),
      join(root, "group/charlie"),
      join(root, "other/delta"),
      join(root, "other/foxtrot"),
    ];

    await writeText(join(projects[0]!, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await writeText(join(projects[1]!, ".agents/overlord/agents/reviewer.md"), validAgent);
    await writeText(join(projects[2]!, ".claude/skills/verify-build/SKILL.md"), validSkill);
    await writeText(join(projects[3]!, ".claude/agents/team/reviewer.md"), "native claude agent\n");
    await writeText(join(projects[4]!, ".codex/agents/reviewer.toml"), "name = \"reviewer\"\n");

    const result = await discoverScopes({ home, roots: [root] });

    expect(result.diagnostics).toEqual([]);
    expect(scopePaths(result.scopes)).toEqual([home, ...projects]);
    expect(result.scopes.slice(1)).toEqual(projects.map((project) => ({
      type: "project",
      path: project,
      canonical: join(project, ".agents"),
      discoveryRoot: root,
    })));
  });

  it("treats a configured root as a project candidate without hoisting children", async () => {
    const home = await temporaryDirectory();
    const root = join(home, "Projects");
    const organization = join(root, "organization");
    const project = join(organization, "app");
    await writeText(join(root, ".agents/skills/root-skill/SKILL.md"), validSkill.replaceAll("verify-build", "root-skill"));
    await writeText(join(project, ".claude/skills/verify-build/SKILL.md"), validSkill);

    const result = await discoverScopes({ home, roots: [root] });

    expect(scopePaths(result.scopes)).toEqual([home, root, project]);
    expect(result.scopes).toContainEqual(expect.objectContaining({
      type: "project",
      path: root,
      canonical: join(root, ".agents"),
      discoveryRoot: root,
    }));
    expect(result.scopes).not.toContainEqual(expect.objectContaining({ path: organization }));
    expect(result.scopes[2]).toMatchObject({ canonical: join(project, ".agents") });
    expect(result.physicalPaths.get(project)).toBe(await realpath(project));
  });

  it("does not discover a project from .codex/skills alone", async () => {
    const home = await temporaryDirectory();
    const root = join(home, "Projects");
    await writeText(join(root, "ignored/.codex/skills/verify-build/SKILL.md"), validSkill);

    const result = await discoverScopes({ home, roots: [root] });

    expect(scopePaths(result.scopes)).toEqual([home]);
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps sibling and nested scopes isolated and deduplicates overlapping roots", async () => {
    const home = await temporaryDirectory();
    const root = join(home, "Projects");
    const overlappingRoot = join(root, "organization");
    const alpha = join(overlappingRoot, "alpha");
    const nested = join(alpha, "packages/nested");
    const bravo = join(root, "bravo");
    await writeText(join(alpha, ".agents/skills/shared/SKILL.md"), validSkill.replaceAll("verify-build", "shared"));
    await writeText(join(nested, ".agents/skills/shared/SKILL.md"), validSkill.replaceAll("verify-build", "shared"));
    await writeText(join(bravo, ".agents/skills/shared/SKILL.md"), validSkill.replaceAll("verify-build", "shared"));

    const result = await discoverScopes({ home, roots: [overlappingRoot, root, root] });

    expect(scopePaths(result.scopes)).toEqual([home, ...[alpha, nested, bravo].sort()]);
    expect(new Set(scopePaths(result.scopes)).size).toBe(result.scopes.length);
  });

  it("ignores Git markers and Claude commands when no skills or agents exist", async () => {
    const home = await temporaryDirectory();
    const root = join(home, "Projects");
    await mkdir(join(root, "git-only/.git"), { recursive: true });
    await writeText(join(root, "commands-only/.claude/commands/deploy.md"), "Deploy safely.\n");

    const result = await discoverScopes({ home, roots: [root] });

    expect(scopePaths(result.scopes)).toEqual([home]);
    expect(result.diagnostics).toEqual([]);
  });

  it("prunes dependency and build trees and never follows directory symlinks", async () => {
    const home = await temporaryDirectory();
    const root = join(home, "Projects");
    const visible = join(root, "visible");
    await writeText(join(visible, ".agents/skills/verify-build/SKILL.md"), validSkill);

    for (const directory of ["node_modules", "vendor", "dist", "build", ".cache", ".venv"]) {
      await writeText(join(root, directory, "hidden/.agents/skills/verify-build/SKILL.md"), validSkill);
    }

    await writeText(
      join(visible, ".agents/skills/verify-build/assets/false-project/.claude/agents/reviewer.md"),
      "not a project marker\n",
    );
    const outside = join(home, "outside/project");
    await writeText(join(outside, ".agents/skills/verify-build/SKILL.md"), validSkill);
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "linked-project"));

    const result = await discoverScopes({ home, roots: [root] });

    expect(scopePaths(result.scopes)).toEqual([home, visible]);
  });

  it("reports a missing root while continuing through readable roots", async () => {
    const home = await temporaryDirectory();
    const missing = join(home, "missing-projects");
    const readable = join(home, "Projects");
    const project = join(readable, "app");
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);

    const result = await discoverScopes({ home, roots: [missing, readable] });

    expect(scopePaths(result.scopes)).toEqual([home, project]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: "error",
      path: missing,
    }));
  });

  it("does not emit the user home again as a project when a root contains it", async () => {
    const parent = await temporaryDirectory();
    const home = join(parent, "home");
    await writeText(join(home, ".agents/skills/verify-build/SKILL.md"), validSkill);

    const result = await discoverScopes({ home, roots: [parent] });

    expect(scopePaths(result.scopes)).toEqual([home]);
  });

  it("discovers a project with a symlinked artifact marker without following it", async () => {
    const home = await temporaryDirectory();
    const root = join(home, "Projects");
    const project = join(root, "linked-artifact");
    const outside = join(home, "outside-skills");
    await writeText(join(outside, "verify-build/SKILL.md"), validSkill);
    await mkdir(join(project, ".claude"), { recursive: true });
    await symlink(outside, join(project, ".claude/skills"));

    const result = await discoverScopes({ home, roots: [root] });

    expect(scopePaths(result.scopes)).toEqual([home, project]);
  });

  it.skipIf(process.platform !== "darwin")("prunes case-aliased control directories on macOS", async () => {
    const home = await temporaryDirectory();
    const root = join(home, "Projects");
    const project = join(root, "app");
    await writeText(
      join(project, ".AGENTS/skills/outer/SKILL.md"),
      validSkill.replaceAll("verify-build", "outer"),
    );
    await writeText(
      join(project, ".AGENTS/skills/outer/payload/.claude/agents/reviewer.md"),
      "nested payload, not a project definition\n",
    );

    const result = await discoverScopes({ home, roots: [root] });

    expect(scopePaths(result.scopes)).toEqual([home, project]);
  });
});
