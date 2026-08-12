import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { ignoredSkillArtifact, reservedSkillArtifact } from "./filesystem.js";
import type { GitCommitRecord } from "./types.js";

export interface UserRepositoryState {
  created: boolean;
  hasHead: boolean;
}

export interface ExistingUserRepositoryState {
  hasHead: boolean;
}

export interface CommitManagedChangesOptions {
  /** Absolute path to the user-owned `.agents` repository. */
  root: string;
  /** Exact absolute canonical paths that Overlord is allowed to commit. */
  paths: readonly string[];
  /** Absolute canonical or provider endpoints responsible for the changes. */
  origins: readonly string[];
  /** Fixed, caller-selected commit subject. */
  message: string;
}

export type ManagedCommit = GitCommitRecord;

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const GIT_IDENTITY = [
  "-c", "user.name=Overlord",
  "-c", "user.email=overlord@localhost",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fileMode=true",
] as const;

const INHERITED_REPOSITORY_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_AUTHOR_DATE",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMON_DIR",
  "GIT_COMMITTER_DATE",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryError(path: string, message: string): Error {
  return Object.assign(new Error(message), { code: "permission-denied", path });
}

function commandError(root: string, args: readonly string[], result: GitResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `Git exited with status ${result.exitCode}`;
  return Object.assign(new Error(`Git ${args[0] ?? "command"} failed in ${root}: ${detail}`), {
    code: "internal",
    path: root,
    detail,
  });
}

async function runGit(
  root: string,
  args: readonly string[],
  allowFailure = false,
  pinRepository = true,
): Promise<GitResult> {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  const pinnedGit = environment.OVERLORD_GIT_EXECUTABLE;
  if (pinnedGit !== undefined && !isAbsolute(pinnedGit)) {
    throw repositoryError(root, `OVERLORD_GIT_EXECUTABLE must be an absolute path: ${pinnedGit}`);
  }
  const gitExecutable = pinnedGit ?? "git";
  for (const variable of INHERITED_REPOSITORY_VARIABLES) delete environment[variable];
  Object.assign(environment, {
    GCM_INTERACTIVE: "Never",
    GIT_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  });
  const result = await new Promise<GitResult>((accept, reject) => {
    const child = spawn(
      gitExecutable,
      [
        "--literal-pathspecs",
        ...GIT_IDENTITY,
        "-C", root,
        ...(pinRepository ? ["--git-dir=.git", "--work-tree=."] : []),
        ...args,
      ],
      {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      accept({
        exitCode: code ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
  if (!allowFailure && result.exitCode !== 0) throw commandError(root, args, result);
  return result;
}

async function metadataOrUndefined(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function normalizedAbsolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${label} must be an absolute normalized path: ${path}`);
  }
  return path;
}

async function assertPhysicalRepository(root: string): Promise<void> {
  const metadata = await metadataOrUndefined(join(root, ".git"));
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw repositoryError(join(root, ".git"), `User repository .git must be a dedicated physical directory: ${join(root, ".git")}`);
  }

  const topLevelResult = await runGit(root, ["rev-parse", "--show-toplevel"], true, false);
  if (topLevelResult.exitCode !== 0) {
    const detail = topLevelResult.stderr.trim() || topLevelResult.stdout.trim() || "Git could not read the repository.";
    throw repositoryError(join(root, ".git"), `User repository is invalid: ${detail}`);
  }
  const reportedTopLevel = topLevelResult.stdout.trim();
  let physicalTopLevel: string;
  try {
    physicalTopLevel = await realpath(reportedTopLevel);
  } catch {
    throw repositoryError(root, `User repository reported an invalid top-level directory: ${reportedTopLevel}`);
  }
  const physicalRoot = await realpath(root);
  if (physicalTopLevel !== physicalRoot) {
    throw repositoryError(
      root,
      `User repository top-level must be ${physicalRoot}; Git reported ${physicalTopLevel}.`,
    );
  }
}

/** Ensure the user source has its own physical Git repository. */
export async function ensureUserRepository(root: string): Promise<UserRepositoryState> {
  const repository = normalizedAbsolute(root, "User repository root");
  await mkdir(repository, { recursive: true });
  const rootMetadata = await lstat(repository);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw repositoryError(repository, `User repository root must be a physical directory: ${repository}`);
  }

  const gitPath = join(repository, ".git");
  const existingGit = await metadataOrUndefined(gitPath);
  if (existingGit !== undefined && (existingGit.isSymbolicLink() || !existingGit.isDirectory())) {
    throw repositoryError(gitPath, `User repository .git must be a dedicated physical directory: ${gitPath}`);
  }

  const created = existingGit === undefined;
  if (created) await runGit(repository, ["init", "--quiet", "--initial-branch=main", "."], false, false);
  await assertPhysicalRepository(repository);
  const head = await runGit(repository, ["rev-parse", "--verify", "--quiet", "HEAD"], true);
  return { created, hasHead: head.exitCode === 0 };
}

/** Validate an existing user repository without creating or modifying it. */
export async function requireUserRepository(root: string): Promise<ExistingUserRepositoryState> {
  const repository = normalizedAbsolute(root, "User repository root");
  const rootMetadata = await metadataOrUndefined(repository);
  if (rootMetadata === undefined || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw repositoryError(repository, `User repository root must be a physical directory: ${repository}`);
  }
  await assertPhysicalRepository(repository);
  const head = await runGit(repository, ["rev-parse", "--verify", "--quiet", "HEAD"], true);
  return { hasHead: head.exitCode === 0 };
}

function managedPathspecs(root: string, paths: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const candidate of paths) {
    normalizedAbsolute(candidate, "Managed path");
    const fromRoot = relative(root, candidate);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new TypeError(`Managed path must be inside the user repository: ${candidate}`);
    }
    const firstComponent = fromRoot.split(sep, 1)[0];
    if (firstComponent === ".git") throw new TypeError(`Managed path cannot include repository metadata: ${candidate}`);
    unique.add(fromRoot.split(sep).join("/"));
  }
  return [...unique].sort(compareText);
}

function normalizedOrigins(origins: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const origin of origins) unique.add(normalizedAbsolute(origin, "Change origin"));
  return [...unique].sort(compareText);
}

function validateSubject(message: string): void {
  if (message.trim().length === 0 || message.includes("\n") || message.includes("\r")) {
    throw new TypeError("Managed commit message must be one non-empty subject line.");
  }
}

function nullSeparated(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

async function stageablePathspecs(root: string, pathspecs: readonly string[]): Promise<string[]> {
  const stageable: string[] = [];
  for (const pathspec of pathspecs) {
    const absolute = join(root, ...pathspec.split("/"));
    if (await metadataOrUndefined(absolute) !== undefined) {
      stageable.push(pathspec);
      continue;
    }
    const index = await runGit(root, ["ls-files", "-z", "--", pathspec]);
    if (index.stdout.length > 0) {
      stageable.push(pathspec);
      continue;
    }
    const head = await runGit(root, ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", pathspec], true);
    if (head.exitCode === 0 && head.stdout.length > 0) stageable.push(pathspec);
  }
  return stageable;
}

async function clearSelectedIndexFlags(root: string, pathspecs: readonly string[]): Promise<void> {
  const tracked = await runGit(root, ["ls-files", "-v", "-z", "--", ...pathspecs]);
  const assumeUnchanged: string[] = [];
  const skipWorktree: string[] = [];
  for (const entry of nullSeparated(tracked.stdout)) {
    const tag = entry[0];
    if (entry[1] !== " " || tag === undefined) continue;
    const path = entry.slice(2);
    if (tag >= "a" && tag <= "z") assumeUnchanged.push(path);
    if (tag.toUpperCase() === "S") skipWorktree.push(path);
  }
  if (assumeUnchanged.length > 0) {
    await runGit(root, ["update-index", "--no-assume-unchanged", "--", ...assumeUnchanged]);
  }
  if (skipWorktree.length > 0) {
    await runGit(root, ["update-index", "--no-skip-worktree", "--", ...skipWorktree]);
  }
}

async function changedWorktreePathspecs(
  root: string,
  pathspecs: readonly string[],
  hasHead: boolean,
): Promise<string[]> {
  const changed: string[] = [];
  for (const pathspec of pathspecs) {
    const absolute = join(root, ...pathspec.split("/"));
    const present = await metadataOrUndefined(absolute) !== undefined;
    if (!hasHead) {
      if (present) changed.push(pathspec);
      continue;
    }
    const head = await runGit(root, ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", pathspec]);
    if (head.stdout.length === 0) {
      if (present) changed.push(pathspec);
      continue;
    }
    const difference = await runGit(root, ["diff", "--quiet", "HEAD", "--", pathspec], true);
    if (difference.exitCode === 1) {
      changed.push(pathspec);
      continue;
    }
    if (difference.exitCode !== 0) throw commandError(root, ["diff"], difference);
    const [ordinary, ignored] = await Promise.all([
      runGit(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec]),
      runGit(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", pathspec]),
    ]);
    if (ordinary.stdout.length > 0 || ignored.stdout.length > 0) changed.push(pathspec);
  }
  return changed;
}

async function stagedPathspecs(root: string, pathspecs: readonly string[]): Promise<string[]> {
  const staged: string[] = [];
  for (const pathspec of pathspecs) {
    const difference = await runGit(root, ["diff", "--cached", "--quiet", "--", pathspec], true);
    if (difference.exitCode === 1) staged.push(pathspec);
    else if (difference.exitCode !== 0) throw commandError(root, ["diff"], difference);
  }
  return staged;
}

function ignoredManagedPath(pathspec: string): boolean {
  return pathspec.split("/").some((component) => ignoredSkillArtifact(component));
}

async function collectPhysicalFiles(root: string, current: string, files: Set<string>): Promise<void> {
  if (current !== root && ignoredSkillArtifact(current)) return;
  if (current !== root && reservedSkillArtifact(current)) {
    throw repositoryError(current, `Managed skill paths must not contain nested Git metadata: ${current}`);
  }
  const metadata = await metadataOrUndefined(current);
  if (metadata === undefined) return;
  if (metadata.isSymbolicLink()) {
    throw repositoryError(current, `Managed commit paths must not contain symlinks: ${current}`);
  }
  if (metadata.isFile()) {
    files.add(relative(root, current).split(sep).join("/"));
    return;
  }
  if (!metadata.isDirectory()) {
    throw repositoryError(current, `Managed commit paths must contain only physical files and directories: ${current}`);
  }
  const children = await readdir(current);
  children.sort(compareText);
  for (const child of children) await collectPhysicalFiles(root, join(current, child), files);
}

async function managedFilePathspecs(root: string, pathspecs: readonly string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const pathspec of pathspecs) {
    await collectPhysicalFiles(root, join(root, ...pathspec.split("/")), files);
    const [index, head] = await Promise.all([
      runGit(root, ["ls-files", "-z", "--", pathspec]),
      runGit(root, ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", pathspec], true),
    ]);
    for (const tracked of [...nullSeparated(index.stdout), ...nullSeparated(head.stdout)]) {
      const trackedPath = join(root, ...tracked.split("/"));
      if (!ignoredManagedPath(tracked) || await metadataOrUndefined(trackedPath) === undefined) files.add(tracked);
    }
  }
  return [...files].sort(compareText);
}

/** Commit exactly the supplied user-canonical paths while preserving all unrelated index entries. */
export async function commitManagedChanges(options: CommitManagedChangesOptions): Promise<ManagedCommit | null> {
  const root = normalizedAbsolute(options.root, "User repository root");
  validateSubject(options.message);
  const pathspecs = managedPathspecs(root, options.paths);
  const origins = normalizedOrigins(options.origins);
  const repository = await requireUserRepository(root);
  if (pathspecs.length === 0) return null;
  const stageable = await stageablePathspecs(root, pathspecs);
  if (stageable.length === 0) return null;

  await clearSelectedIndexFlags(root, stageable);
  const changed = await changedWorktreePathspecs(root, stageable, repository.hasHead);
  if (changed.length === 0) return null;
  const managedFiles = await managedFilePathspecs(root, changed);
  if (managedFiles.length === 0) return null;
  await runGit(root, ["add", "--all", "--force", "--", ...managedFiles]);
  const committable = await stagedPathspecs(root, managedFiles);
  if (committable.length === 0) return null;
  await runGit(root, [
    "commit",
    "--only",
    "--no-gpg-sign",
    "--no-verify",
    "--quiet",
    "--message",
    options.message,
    "--",
    ...committable,
  ]);

  const [shaResult, filesResult] = await Promise.all([
    runGit(root, ["rev-parse", "HEAD"]),
    runGit(root, [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "--no-renames",
      "-r",
      "-z",
      "HEAD",
    ]),
  ]);
  const files = nullSeparated(filesResult.stdout)
    .map((path) => join(root, ...path.split("/")))
    .sort(compareText);

  return {
    repository: root,
    sha: shaResult.stdout.trim(),
    message: options.message,
    origins,
    files,
  };
}
