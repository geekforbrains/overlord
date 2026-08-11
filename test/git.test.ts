import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { commitManagedChanges, ensureUserRepository } from "../src/git.js";
import { cleanupTemporaryDirectories, temporaryDirectory, writeText } from "./helpers.js";

const execFileAsync = promisify(execFile);

afterEach(cleanupTemporaryDirectories);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trim();
}

async function writeManagedSkill(root: string, source: string): Promise<string> {
  const path = join(root, "skills", "review", "SKILL.md");
  await writeText(path, source);
  return path;
}

describe("user Git history", () => {
  it("creates a dedicated main repository and reports whether it has a commit", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, ".agents");

    await expect(ensureUserRepository(root)).resolves.toEqual({ created: true, hasHead: false });
    expect((await lstat(join(root, ".git"))).isDirectory()).toBe(true);
    expect((await lstat(join(root, ".git"))).isSymbolicLink()).toBe(false);
    expect(await git(root, ["symbolic-ref", "--short", "HEAD"])).toBe("main");

    await expect(ensureUserRepository(root)).resolves.toEqual({ created: false, hasHead: false });
  });

  it("commits only supplied paths with invocation-local identity and the supplied subject", async () => {
    const root = join(await temporaryDirectory(), ".agents");
    await ensureUserRepository(root);
    await git(root, ["config", "commit.gpgSign", "true"]);
    const hook = join(root, ".git", "hooks", "pre-commit");
    await writeText(hook, "#!/bin/sh\nexit 73\n", 0o755);
    const managed = await writeManagedSkill(root, "first\n");
    const origin = join(resolve(root, ".."), ".claude", "skills", "review");

    const result = await commitManagedChanges({
      root,
      paths: [managed],
      origins: [origin],
      message: "sync: update user definitions",
    });

    expect(result).toEqual({
      repository: root,
      sha: expect.stringMatching(/^[0-9a-f]{40,64}$/),
      message: "sync: update user definitions",
      origins: [origin],
      files: [managed],
    });
    expect(await git(root, ["log", "-1", "--pretty=%s"])).toBe("sync: update user definitions");
    expect(await git(root, ["log", "-1", "--pretty=%an <%ae>"])).toBe("Overlord <overlord@localhost>");
    await expect(ensureUserRepository(root)).resolves.toEqual({ created: false, hasHead: true });
  });

  it("returns null without changing HEAD when managed paths have no changes", async () => {
    const root = join(await temporaryDirectory(), ".agents");
    await ensureUserRepository(root);
    const managed = await writeManagedSkill(root, "first\n");
    const input = { root, paths: [managed], origins: [], message: "sync: update user definitions" };
    await commitManagedChanges(input);
    const before = await git(root, ["rev-parse", "HEAD"]);
    const beforeIndex = await lstat(join(root, ".git/index"), { bigint: true });

    await expect(commitManagedChanges(input)).resolves.toBeNull();
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(before);
    const afterIndex = await lstat(join(root, ".git/index"), { bigint: true });
    expect({ inode: afterIndex.ino, modified: afterIndex.mtimeNs }).toEqual({
      inode: beforeIndex.ino,
      modified: beforeIndex.mtimeNs,
    });
  });

  it("refuses to recreate repository metadata that disappears before a commit", async () => {
    const root = join(await temporaryDirectory(), ".agents");
    await ensureUserRepository(root);
    const managed = await writeManagedSkill(root, "first\n");
    await rm(join(root, ".git"), { recursive: true });

    await expect(commitManagedChanges({
      root,
      paths: [managed],
      origins: [],
      message: "sync: update user definitions",
    })).rejects.toMatchObject({ code: "permission-denied" });
    await expect(lstat(join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores an absent path that has never been tracked", async () => {
    const root = join(await temporaryDirectory(), ".agents");
    await ensureUserRepository(root);
    const absent = join(root, "skills", "missing", "SKILL.md");

    await expect(commitManagedChanges({
      root,
      paths: [absent],
      origins: [],
      message: "sync: update user definitions",
    })).resolves.toBeNull();
  });

  it("returns null without clearing a stale index-only change when the worktree is clean", async () => {
    const root = join(await temporaryDirectory(), ".agents");
    await ensureUserRepository(root);
    const managed = await writeManagedSkill(root, "first\n");
    const input = { root, paths: [managed], origins: [], message: "sync: update user definitions" };
    await commitManagedChanges(input);
    const before = await git(root, ["rev-parse", "HEAD"]);
    await writeText(managed, "stale staged value\n");
    await git(root, ["add", "--", "skills/review/SKILL.md"]);
    await writeText(managed, "first\n");

    await expect(commitManagedChanges(input)).resolves.toBeNull();

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(before);
    expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("skills/review/SKILL.md");
  });

  it("records managed deletions", async () => {
    const root = join(await temporaryDirectory(), ".agents");
    await ensureUserRepository(root);
    const managed = await writeManagedSkill(root, "first\n");
    const input = { root, paths: [managed], origins: [], message: "sync: update user definitions" };
    await commitManagedChanges(input);
    await rm(managed);

    const result = await commitManagedChanges(input);

    expect(result?.files).toEqual([managed]);
    expect(await git(root, ["show", "--format=", "--name-status", "HEAD"])).toBe("D\tskills/review/SKILL.md");
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "commits selected tracked content even when its index entry uses %s",
    async (indexFlag) => {
      const root = join(await temporaryDirectory(), ".agents");
      await ensureUserRepository(root);
      const managed = await writeManagedSkill(root, "first\n");
      const input = { root, paths: [managed], origins: [], message: "sync: update user definitions" };
      await commitManagedChanges(input);
      await git(root, ["update-index", indexFlag, "--", "skills/review/SKILL.md"]);
      await writeText(managed, "second\n");

      const result = await commitManagedChanges(input);

      expect(result?.files).toEqual([managed]);
      expect(await git(root, ["show", "HEAD:skills/review/SKILL.md"])).toBe("second");
    },
  );

  it("records executable-bit changes even when repository file-mode detection is disabled", async () => {
    const root = join(await temporaryDirectory(), ".agents");
    await ensureUserRepository(root);
    const managed = await writeManagedSkill(root, "executable skill\n");
    const input = { root, paths: [managed], origins: [], message: "sync: update user definitions" };
    await commitManagedChanges(input);
    await git(root, ["config", "core.filemode", "false"]);
    await chmod(managed, 0o755);

    const result = await commitManagedChanges(input);

    expect(result?.files).toEqual([managed]);
    expect(await git(root, ["ls-tree", "HEAD", "--", "skills/review/SKILL.md"])).toMatch(/^100755 /);
  });

  it("leaves unrelated staged content staged and out of the managed commit", async () => {
    const root = join(await temporaryDirectory(), ".agents");
    await ensureUserRepository(root);
    const managed = await writeManagedSkill(root, "first\n");
    await commitManagedChanges({ root, paths: [managed], origins: [], message: "sync: initial state" });
    const unrelated = join(root, "notes.txt");
    await writeText(unrelated, "keep staged\n");
    await git(root, ["add", "--", "notes.txt"]);
    await writeText(managed, "second\n");

    await commitManagedChanges({
      root,
      paths: [managed],
      origins: [],
      message: "sync: update user definitions",
    });

    expect(await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe(
      "skills/review/SKILL.md",
    );
    expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("notes.txt");
  });

  it("commits managed content even when a repository ignore rule matches it", async () => {
    const root = join(await temporaryDirectory(), ".agents");
    await ensureUserRepository(root);
    await writeText(join(root, ".gitignore"), "skills/\n");
    const managed = await writeManagedSkill(root, "managed despite ignore\n");

    const result = await commitManagedChanges({
      root,
      paths: [managed],
      origins: [],
      message: "sync: update user definitions",
    });

    expect(result?.files).toEqual([managed]);
    expect(await git(root, ["ls-files", "--", "skills/review/SKILL.md"])).toBe("skills/review/SKILL.md");
    expect(await git(root, ["status", "--porcelain=v1", "--", ".gitignore"])).toBe("?? .gitignore");
  });

  it("keeps ignored operating-system metadata out of managed skill commits", async () => {
    const root = join(await temporaryDirectory(), ".agents");
    await ensureUserRepository(root);
    const skill = join(root, "skills", "review");
    const managed = await writeManagedSkill(root, "managed skill\n");
    await writeText(join(skill, ".DS_Store"), "noise\n");
    await writeText(join(skill, "references/._resource"), "noise\n");

    const result = await commitManagedChanges({
      root,
      paths: [skill],
      origins: [],
      message: "sync: update user definitions",
    });

    expect(result?.files).toEqual([managed]);
    expect(await git(root, ["ls-files", "--", "skills/review/.DS_Store", "skills/review/references/._resource"]))
      .toBe("");
  });

  it("removes previously tracked operating-system metadata with a deleted skill", async () => {
    const root = join(await temporaryDirectory(), ".agents");
    await ensureUserRepository(root);
    const skill = join(root, "skills", "review");
    const managed = await writeManagedSkill(root, "managed skill\n");
    const metadata = join(skill, ".DS_Store");
    await writeText(metadata, "previously tracked noise\n");
    await git(root, ["add", "--force", "--", "skills/review/SKILL.md", "skills/review/.DS_Store"]);
    await git(root, [
      "-c", "user.name=Fixture",
      "-c", "user.email=fixture@localhost",
      "commit", "--quiet", "--message", "seed tracked metadata",
    ]);
    await rm(skill, { recursive: true });

    const result = await commitManagedChanges({
      root,
      paths: [skill],
      origins: [],
      message: "sync: update user definitions",
    });

    expect(result?.files).toEqual([metadata, managed].sort());
    expect(await git(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", "skills/review"])).toBe("");
  });

  it("refuses nested Git metadata instead of recording a skill as a gitlink", async () => {
    const root = join(await temporaryDirectory(), ".agents");
    await ensureUserRepository(root);
    const skill = join(root, "skills", "review");
    await writeManagedSkill(root, "managed skill\n");
    await execFileAsync("git", ["init", "--quiet", skill]);

    await expect(commitManagedChanges({
      root,
      paths: [skill],
      origins: [],
      message: "sync: update user definitions",
    })).rejects.toThrow(/nested Git metadata/i);
    expect(await git(root, ["ls-files", "--", "skills/review"])).toBe("");
  });

  it("treats supplied paths as literal and rejects paths outside the repository", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, ".agents");
    await ensureUserRepository(root);
    const literal = join(root, "skills", "review[1]", "SKILL.md");
    const wildcardMatch = join(root, "skills", "review1", "SKILL.md");
    await writeText(literal, "literal\n");
    await writeText(wildcardMatch, "must remain untracked\n");

    const result = await commitManagedChanges({
      root,
      paths: [literal],
      origins: [],
      message: "sync: update user definitions",
    });

    expect(result?.files).toEqual([literal]);
    expect(await git(root, ["status", "--porcelain=v1", "--", "skills/review1/SKILL.md"])).toBe(
      "?? skills/review1/SKILL.md",
    );
    await expect(commitManagedChanges({
      root,
      paths: [join(parent, "outside.md")],
      origins: [],
      message: "sync: invalid",
    })).rejects.toThrow(/inside the user repository/i);
    await expect(commitManagedChanges({
      root,
      paths: ["skills/review/SKILL.md"],
      origins: [],
      message: "sync: invalid",
    })).rejects.toThrow(/absolute/i);
  });

  it("rejects .git files, symlinks, and repositories whose work tree is elsewhere", async () => {
    const parent = await temporaryDirectory();

    const fileRoot = join(parent, "file-root");
    await writeText(join(fileRoot, ".git"), "gitdir: ../foreign/.git\n");
    await expect(ensureUserRepository(fileRoot)).rejects.toThrow(/physical directory/i);

    const foreign = join(parent, "foreign");
    await ensureUserRepository(foreign);
    const symlinkRoot = join(parent, "symlink-root");
    await mkdir(symlinkRoot);
    await symlink(join(foreign, ".git"), join(symlinkRoot, ".git"));
    expect(await readlink(join(symlinkRoot, ".git"))).toBe(join(foreign, ".git"));
    await expect(ensureUserRepository(symlinkRoot)).rejects.toThrow(/physical directory/i);

    const displacedRoot = join(parent, "displaced-root");
    await ensureUserRepository(displacedRoot);
    await git(displacedRoot, ["config", "core.worktree", foreign]);
    await expect(ensureUserRepository(displacedRoot)).rejects.toThrow(/top-level/i);
  });

  it("never pushes commits", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, ".agents");
    const remote = join(parent, "remote.git");
    await ensureUserRepository(root);
    await execFileAsync("git", ["init", "--bare", "--quiet", remote]);
    await git(root, ["remote", "add", "origin", remote]);
    const managed = await writeManagedSkill(root, "first\n");

    await commitManagedChanges({ root, paths: [managed], origins: [], message: "sync: initial state" });

    await expect(execFileAsync("git", ["--git-dir", remote, "rev-parse", "--verify", "HEAD"]))
      .rejects.toThrow(/needed a single revision|unknown revision|bad revision/i);
  });
});
