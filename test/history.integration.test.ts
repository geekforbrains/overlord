import { execFile } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { initialize, inspect, synchronize } from "../src/engine.js";
import { ensureUserRepository } from "../src/git.js";
import { ledgerPath, physicalScopeIdentity } from "../src/ledger.js";
import type { EngineOptions } from "../src/types.js";
import { cleanupTemporaryDirectories, temporaryDirectory, validAgent, validSkill, writeText } from "./helpers.js";

const execFileAsync = promisify(execFile);

afterEach(cleanupTemporaryDirectories);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function options(home: string): EngineOptions {
  return {
    home,
    env: {
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
    },
  };
}

function namedAgent(name: string): string {
  return validAgent
    .replace("name: reviewer", `name: ${name}`)
    .replace("Reviews a change", `Reviews ${name} changes`);
}

describe("user source history", () => {
  it("initializes the user repository with one deterministic commit", async () => {
    const home = await temporaryDirectory();
    const first = await initialize(options(home));
    const root = join(home, ".agents");
    const firstHead = await git(root, ["rev-parse", "HEAD"]);

    expect(await git(root, ["log", "-1", "--pretty=%s"])).toBe("overlord: initialize");
    expect(first.actions).toContainEqual(expect.objectContaining({
      status: "completed",
      commit: expect.objectContaining({
        repository: root,
        sha: firstHead,
        message: "overlord: initialize",
      }),
    }));

    const second = await initialize(options(home));
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(firstHead);
    expect(second.actions?.some((action) => action.commit !== undefined)).toBe(false);
  });

  it("commits init-managed files when retrying a failed commit in an existing repository", async () => {
    const home = await temporaryDirectory();
    const runtime = options(home);
    const root = join(home, ".agents");
    await ensureUserRepository(root);
    await writeText(join(root, "README.md"), "existing repository\n");
    await writeText(join(root, "skills/verify-build/SKILL.md"), validSkill);
    const retired = join(root, "skills/retired");
    await writeText(join(retired, "SKILL.md"), validSkill.replaceAll("verify-build", "retired"));
    await execFileAsync("git", ["-C", root, "add", "README.md", "skills/retired/SKILL.md"]);
    await execFileAsync("git", [
      "-C", root,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "--quiet", "-m", "existing history",
    ]);
    await rm(retired, { recursive: true });
    const indexLock = join(root, ".git/index.lock");
    await writeFile(indexLock, "locked\n");

    await expect(initialize(runtime)).rejects.toThrow(/Git .* failed/i);
    await rm(indexLock);
    const retried = await initialize(runtime);

    expect(retried.actions?.filter((action) => action.commit !== undefined)).toHaveLength(1);
    expect(await git(root, ["log", "-1", "--pretty=%s"])).toBe("overlord: initialize");
    expect((await git(root, [
      "ls-files", "--",
      "overlord/overlord.yaml",
      "skills/overlord/SKILL.md",
      "skills/verify-build/SKILL.md",
    ])).split("\n")).toEqual([
      "overlord/overlord.yaml",
      "skills/overlord/SKILL.md",
      "skills/verify-build/SKILL.md",
    ]);
    expect(await git(root, ["ls-files", "--", "skills/retired/SKILL.md"])).toBe("");
  });

  it("commits a user provider edit before updating the other provider", async () => {
    const home = await temporaryDirectory();
    const runtime = options(home);
    const root = join(home, ".agents");
    const canonical = join(root, "overlord/agents/reviewer.md");
    const claude = join(home, ".claude/agents/reviewer.md");
    const codex = join(home, ".codex/agents/reviewer.toml");
    await initialize(runtime);
    await writeText(canonical, validAgent);
    expect((await synchronize(runtime)).status).toBe("ok");

    await writeText(
      claude,
      (await readFile(claude, "utf8")).replace(
        "Reviews a change for correctness and missing tests.",
        "Reviews user changes with the revised workflow.",
      ),
    );
    const result = await synchronize(runtime);
    const commit = result.actions?.find((action) => action.commit !== undefined)?.commit;

    expect(result.status).toBe("ok");
    expect(commit).toMatchObject({
      repository: root,
      message: "overlord: synchronize",
      origins: [claude],
      files: [canonical],
    });
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(commit?.sha);
    expect(await readFile(codex, "utf8")).toContain("revised workflow");
  });

  it("commits a tracked user deletion before removing its remaining endpoint", async () => {
    const home = await temporaryDirectory();
    const runtime = options(home);
    const root = join(home, ".agents");
    const canonical = join(root, "skills/verify-build");
    const claude = join(home, ".claude/skills/verify-build");
    await initialize(runtime);
    await writeText(join(canonical, "SKILL.md"), validSkill);
    expect((await synchronize(runtime)).status).toBe("ok");

    await rm(claude, { recursive: true });
    const result = await synchronize(runtime);
    const commit = result.actions?.find((action) => action.commit !== undefined)?.commit;

    expect(result.status).toBe("ok");
    expect(commit).toMatchObject({
      repository: root,
      message: "overlord: synchronize",
      origins: [claude],
      files: [join(canonical, "SKILL.md")],
    });
    await expect(readFile(join(canonical, "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(claude, "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records simultaneous provider changes in one user commit", async () => {
    const home = await temporaryDirectory();
    const runtime = options(home);
    const root = join(home, ".agents");
    const firstCanonical = join(root, "overlord/agents/alpha.md");
    const secondCanonical = join(root, "overlord/agents/bravo.md");
    const claudeOrigin = join(home, ".claude/agents/alpha.md");
    const codexOrigin = join(home, ".codex/agents/bravo.toml");
    await initialize(runtime);
    await writeText(firstCanonical, namedAgent("alpha"));
    await writeText(secondCanonical, namedAgent("bravo"));
    expect((await synchronize(runtime)).status).toBe("ok");
    await writeText(
      claudeOrigin,
      (await readFile(claudeOrigin, "utf8")).replace("Reviews alpha changes", "Reviews alpha provider changes"),
    );
    await writeText(
      codexOrigin,
      (await readFile(codexOrigin, "utf8")).replace("Reviews bravo changes", "Reviews bravo provider changes"),
    );

    const result = await synchronize(runtime);
    const commits = result.actions?.flatMap((action) => action.commit === undefined ? [] : [action.commit]) ?? [];

    expect(result.status).toBe("ok");
    expect(commits).toEqual([expect.objectContaining({
      repository: root,
      message: "overlord: synchronize",
      origins: [claudeOrigin, codexOrigin],
      files: [firstCanonical, secondCanonical],
    })]);
  });

  it("commits a valid fleet configuration change during sync", async () => {
    const home = await temporaryDirectory();
    const runtime = options(home);
    const root = join(home, ".agents");
    const configuration = join(root, "overlord/overlord.yaml");
    await initialize(runtime);
    expect((await synchronize(runtime)).status).toBe("ok");
    await writeText(configuration, "roots: []\n# keep project discovery explicit\n");

    const result = await synchronize(runtime);
    const commit = result.actions?.find((action) => action.commit !== undefined)?.commit;

    expect(result.status).toBe("ok");
    expect(commit).toMatchObject({
      repository: root,
      message: "overlord: synchronize",
      origins: [],
      files: [configuration],
    });
  });

  it("records a conflicting canonical edit without choosing a winner", async () => {
    const home = await temporaryDirectory();
    const runtime = options(home);
    const root = join(home, ".agents");
    const canonical = join(root, "skills/verify-build/SKILL.md");
    const claude = join(home, ".claude/skills/verify-build/SKILL.md");
    await initialize(runtime);
    await writeText(canonical, validSkill);
    expect((await synchronize(runtime)).status).toBe("ok");
    const canonicalEdit = validSkill.replace("Run the documented build", "Run the canonical build");
    const claudeEdit = validSkill.replace("Run the documented build", "Run the Claude build");
    await writeText(canonical, canonicalEdit);
    await writeText(claude, claudeEdit);

    const result = await synchronize(runtime);
    const commit = result.actions?.find((action) => action.commit !== undefined)?.commit;

    expect(result.status).toBe("attention-required");
    expect(commit?.files).toEqual([canonical]);
    expect(await readFile(canonical, "utf8")).toBe(canonicalEdit);
    expect(await readFile(claude, "utf8")).toBe(claudeEdit);
  });

  it("commits canonical content before a safe output beside an unresolved conflict", async () => {
    const home = await temporaryDirectory();
    const runtime = options(home);
    const root = join(home, ".agents");
    const canonical = join(root, "overlord/agents/reviewer.md");
    const claude = join(home, ".claude/agents/reviewer.md");
    const codex = join(home, ".codex/agents/reviewer.toml");
    await initialize(runtime);
    await writeText(canonical, validAgent);
    await writeText(
      claude,
      `---\nname: reviewer\ndescription: Uses conflicting Claude guidance.\n---\n\nKeep the Claude-only instructions.\n`,
    );
    const indexLock = join(root, ".git/index.lock");
    await writeFile(indexLock, "locked\n");

    const failed = await synchronize(runtime);

    expect(failed.status).toBe("attention-required");
    await expect(readFile(codex, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await rm(indexLock);
    const retried = await synchronize(runtime);
    const commit = retried.actions?.find((action) => action.commit !== undefined)?.commit;

    expect(retried.status).toBe("attention-required");
    expect(commit?.files).toEqual([canonical]);
    expect(await readFile(codex, "utf8")).toContain("Reviews a change for correctness and missing tests.");
    expect(await readFile(claude, "utf8")).toContain("Claude-only instructions");
  });

  it("keeps repository and ledger state byte-for-byte unchanged during inspection", async () => {
    const home = await temporaryDirectory();
    const runtime = options(home);
    const root = join(home, ".agents");
    await initialize(runtime);
    expect((await synchronize(runtime)).status).toBe("ok");
    await writeText(join(root, "notes.txt"), "preserve staged state\n");
    await git(root, ["add", "--", "notes.txt"]);
    const ledger = ledgerPath(root, await physicalScopeIdentity(home));
    const before = {
      head: await git(root, ["rev-parse", "HEAD"]),
      index: await readFile(join(root, ".git/index")),
      ledger: await readFile(ledger),
    };

    const first = await inspect(runtime);
    const second = await inspect(runtime);

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(await readFile(join(root, ".git/index"))).toEqual(before.index);
    expect(await readFile(ledger)).toEqual(before.ledger);
  });

  it("does not rewrite Git or ledger metadata on a fully synchronized second sync", async () => {
    const home = await temporaryDirectory();
    const projects = await temporaryDirectory();
    const project = join(projects, "app");
    const runtime = options(home);
    const root = join(home, ".agents");
    await initialize(runtime);
    await writeText(join(root, "overlord/overlord.yaml"), `roots:\n  - ${projects}\n`);
    await writeText(join(project, ".agents/skills/verify-build/SKILL.md"), validSkill);
    expect((await synchronize(runtime)).status).toBe("ok");

    const index = join(root, ".git/index");
    const userLedger = ledgerPath(root, await physicalScopeIdentity(home));
    const projectLedger = ledgerPath(root, await physicalScopeIdentity(project));
    const metadata = async (path: string) => {
      const value = await stat(path, { bigint: true });
      return { inode: value.ino, modified: value.mtimeNs, size: value.size };
    };
    const before = {
      head: await git(root, ["rev-parse", "HEAD"]),
      index: await metadata(index),
      userLedger: await metadata(userLedger),
      projectLedger: await metadata(projectLedger),
    };

    const result = await synchronize(runtime);

    expect(result.status).toBe("ok");
    expect(result.actions?.some((action) => action.status === "completed")).toBe(false);
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(await metadata(index)).toEqual(before.index);
    expect(await metadata(userLedger)).toEqual(before.userLedger);
    expect(await metadata(projectLedger)).toEqual(before.projectLedger);
  });

  it("preserves an index-only change for an unaffected managed definition", async () => {
    const home = await temporaryDirectory();
    const runtime = options(home);
    const root = join(home, ".agents");
    const alphaCanonical = join(root, "overlord/agents/alpha.md");
    const bravoCanonical = join(root, "overlord/agents/bravo.md");
    const alphaSource = namedAgent("alpha");
    const bravoSource = namedAgent("bravo");
    const claudeOrigin = join(home, ".claude/agents/alpha.md");
    await initialize(runtime);
    await writeText(alphaCanonical, alphaSource);
    await writeText(bravoCanonical, bravoSource);
    expect((await synchronize(runtime)).status).toBe("ok");

    await writeText(bravoCanonical, bravoSource.replace("Reviews bravo changes", "Reviews a staged-only bravo change"));
    await git(root, ["add", "--", "overlord/agents/bravo.md"]);
    await writeText(bravoCanonical, bravoSource);
    await writeText(
      claudeOrigin,
      (await readFile(claudeOrigin, "utf8")).replace("Reviews alpha changes", "Reviews an alpha provider change"),
    );

    const result = await synchronize(runtime);
    const commit = result.actions?.find((action) => action.commit !== undefined)?.commit;

    expect(result.status).toBe("ok");
    expect(commit?.files).toEqual([alphaCanonical]);
    expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("overlord/agents/bravo.md");
  });

  it("never commits a discovered project repository", async () => {
    const home = await temporaryDirectory();
    const projects = await temporaryDirectory();
    const project = join(projects, "app");
    const runtime = options(home);
    await initialize(runtime);
    await writeText(join(home, ".agents/overlord/overlord.yaml"), `roots:\n  - ${projects}\n`);
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", project]);
    await writeText(join(project, "README.md"), "project\n");
    await execFileAsync("git", ["-C", project, "add", "README.md"]);
    await execFileAsync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "initial"]);
    const head = await git(project, ["rev-parse", "HEAD"]);
    const canonical = join(project, ".agents/overlord/agents/reviewer.md");
    const claude = join(project, ".claude/agents/reviewer.md");
    await writeText(canonical, validAgent);
    expect((await synchronize(runtime)).status).toBe("ok");
    await writeText(claude, (await readFile(claude, "utf8")).replace("Reviews a change", "Reviews a project change"));

    const result = await synchronize(runtime);

    expect(result.status).toBe("ok");
    expect(await git(project, ["rev-parse", "HEAD"])).toBe(head);
    expect(result.actions?.filter((action) => action.scopePath === project).some((action) => action.commit !== undefined)).toBe(false);
  });

  it("stops user provider propagation when the canonical commit fails", async () => {
    const home = await temporaryDirectory();
    const runtime = options(home);
    const root = join(home, ".agents");
    const canonical = join(root, "overlord/agents/reviewer.md");
    const claude = join(home, ".claude/agents/reviewer.md");
    const codex = join(home, ".codex/agents/reviewer.toml");
    await initialize(runtime);
    await writeText(canonical, validAgent);
    expect((await synchronize(runtime)).status).toBe("ok");
    const oldCodex = await readFile(codex, "utf8");
    await writeText(claude, (await readFile(claude, "utf8")).replace("Reviews a change", "Reviews a blocked change"));
    const indexLock = join(root, ".git/index.lock");
    await writeFile(indexLock, "locked\n");

    const failed = await synchronize(runtime);

    expect(failed.status).toBe("attention-required");
    expect(await readFile(canonical, "utf8")).toContain("blocked change");
    expect(await readFile(codex, "utf8")).toBe(oldCodex);
    expect(failed.diagnostics).toContainEqual(expect.objectContaining({ scopePath: home }));

    await rm(indexLock);
    const retried = await synchronize(runtime);
    expect(retried.status).toBe("ok");
    expect(await readFile(codex, "utf8")).toContain("blocked change");
  });

  it("finishes a tracked agent deletion when retrying a failed commit", async () => {
    const home = await temporaryDirectory();
    const runtime = options(home);
    const root = join(home, ".agents");
    const canonical = join(root, "overlord/agents/reviewer.md");
    const claude = join(home, ".claude/agents/reviewer.md");
    const codex = join(home, ".codex/agents/reviewer.toml");
    await initialize(runtime);
    await writeText(canonical, validAgent);
    expect((await synchronize(runtime)).status).toBe("ok");
    await rm(claude);
    const indexLock = join(root, ".git/index.lock");
    await writeFile(indexLock, "locked\n");

    const failed = await synchronize(runtime);

    expect(failed.status).toBe("attention-required");
    await expect(readFile(canonical, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(codex, "utf8")).toContain('name = "reviewer"');

    await rm(indexLock);
    const retried = await synchronize(runtime);

    expect(retried.status).toBe("ok");
    await expect(readFile(canonical, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(claude, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(codex, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
