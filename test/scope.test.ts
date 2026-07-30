import { afterEach, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTemporaryDirectories, temporaryDirectory } from "./helpers.js";
import { resolveScope } from "../src/scope.js";

afterEach(cleanupTemporaryDirectories);

describe("scope resolution", () => {
  it("uses an explicit global scope", async () => {
    const home = await temporaryDirectory();
    const scope = await resolveScope({ cwd: home, home, global: true });
    expect(scope).toEqual({
      type: "user",
      path: home,
      canonical: join(home, ".agents"),
      resolvedBy: "explicit-flag",
      evidence: "--global",
    });
  });

  it("rejects --global with --project", async () => {
    const home = await temporaryDirectory();
    await expect(resolveScope({ cwd: home, home, global: true, project: home })).rejects.toMatchObject({ code: "usage" });
  });

  it("resolves an explicit project path", async () => {
    const home = await temporaryDirectory();
    const project = join(home, "project");
    await mkdir(project);
    const scope = await resolveScope({ cwd: home, home, project });
    expect(scope).toMatchObject({ type: "project", path: project, resolvedBy: "explicit-flag", evidence: project });
  });

  it("selects the nearest .agents ancestor", async () => {
    const home = await temporaryDirectory();
    const project = join(home, "repo");
    const nested = join(project, "packages/app/src");
    await mkdir(join(project, ".agents"), { recursive: true });
    await mkdir(nested, { recursive: true });
    const scope = await resolveScope({ cwd: nested, home });
    expect(scope).toMatchObject({ path: project, resolvedBy: "nearest-ancestor" });
  });

  it("falls back to the Git worktree root, then user scope", async () => {
    const home = await temporaryDirectory();
    const project = join(home, "repo");
    const nested = join(project, "src");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(nested);
    await expect(resolveScope({ cwd: nested, home })).resolves.toMatchObject({ path: project, resolvedBy: "git-worktree-root" });
    await expect(resolveScope({ cwd: home, home })).resolves.toMatchObject({ type: "user", resolvedBy: "user-default" });
  });
});
