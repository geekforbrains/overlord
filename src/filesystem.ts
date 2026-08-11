import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export const IGNORED_SKILL_FILES = new Set([
  ".DS_Store",
  "Desktop.ini",
  "Thumbs.db",
  "ehthumbs.db",
]);

function ignoredSkillArtifact(path: string): boolean {
  const name = basename(path);
  return IGNORED_SKILL_FILES.has(name) || name.startsWith("._");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface TreeEntry {
  relativePath: string;
  kind: "directory" | "file";
  mode: number;
  contents: Buffer;
}

function unsupportedSkillSymlink(root: string, path: string): Error {
  return Object.assign(new Error(`Skill contains symlink '${relative(root, path)}'; symlinks are not supported.`), {
    code: "permission-denied",
    path,
  });
}

async function treeEntries(root: string, current = root): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const children = await readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const path = join(current, child.name);
    const relativePath = relative(root, path).split(sep).join("/");
    if (child.isSymbolicLink()) throw unsupportedSkillSymlink(root, path);
    if (ignoredSkillArtifact(child.name)) continue;
    const info = await lstat(path);
    if (child.isDirectory()) {
      entries.push({ relativePath, kind: "directory", mode: info.mode & 0o777, contents: Buffer.alloc(0) });
      entries.push(...await treeEntries(root, path));
    } else if (child.isFile()) {
      entries.push({ relativePath, kind: "file", mode: info.mode & 0o777, contents: await readFile(path) });
    }
  }
  return entries;
}

/**
 * Require a physical parent chain below a native boundary. A boundary alias is
 * accepted only when its current target matches a caller-pinned physical path.
 */
export async function assertNoSymlinkedParent(
  destination: string,
  boundary: string,
  expectedPhysicalBoundary?: string,
): Promise<void> {
  const absoluteDestination = resolve(destination);
  const absoluteBoundary = resolve(boundary);
  let boundaryMetadata: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    boundaryMetadata = await lstat(absoluteBoundary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const denyBoundary = (message: string): never => {
    throw Object.assign(new Error(message), {
      code: "permission-denied",
      path: absoluteBoundary,
    });
  };
  if (boundaryMetadata === undefined) {
    if (expectedPhysicalBoundary !== undefined) {
      denyBoundary(`Native boundary no longer resolves to its pinned directory: ${absoluteBoundary}`);
    }
  } else {
    if (!boundaryMetadata.isDirectory() && !boundaryMetadata.isSymbolicLink()) {
      denyBoundary(`Native boundary must be a directory: ${absoluteBoundary}`);
    }
    if (boundaryMetadata.isSymbolicLink() && expectedPhysicalBoundary === undefined) {
      denyBoundary(`Native boundary must be a physical directory: ${absoluteBoundary}`);
    }
    if (expectedPhysicalBoundary !== undefined) {
      const physicalBoundary = await realpath(absoluteBoundary).catch(() => (
        denyBoundary(`Native boundary no longer resolves to its pinned directory: ${absoluteBoundary}`)
      ));
      if (physicalBoundary !== expectedPhysicalBoundary) {
        denyBoundary(`Native boundary no longer resolves to its pinned directory: ${absoluteBoundary}`);
      }
      if (!(await lstat(physicalBoundary)).isDirectory()) {
        denyBoundary(`Native boundary target must be a directory: ${absoluteBoundary}`);
      }
    }
  }
  const parent = dirname(absoluteDestination);
  const fromBoundary = relative(absoluteBoundary, parent);
  if (fromBoundary === ".." || fromBoundary.startsWith(`..${sep}`)) {
    throw Object.assign(new Error(`Write path escapes its native boundary: ${destination}`), {
      code: "permission-denied",
      path: destination,
    });
  }
  let current = absoluteBoundary;
  for (const component of fromBoundary.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw Object.assign(new Error(`Refusing to write through symlinked native directory: ${current}`), {
          code: "permission-denied",
          path: current,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

export async function compareDirectories(left: string, right: string): Promise<{ equal: boolean; evidence?: string }> {
  const [leftEntries, rightEntries] = await Promise.all([treeEntries(left), treeEntries(right)]);
  const count = Math.max(leftEntries.length, rightEntries.length);
  for (let index = 0; index < count; index += 1) {
    const leftEntry = leftEntries[index];
    const rightEntry = rightEntries[index];
    if (leftEntry === undefined) return { equal: false, evidence: `extra native file ${rightEntry?.relativePath ?? "unknown"}` };
    if (rightEntry === undefined) return { equal: false, evidence: `native output is missing ${leftEntry.relativePath}` };
    if (leftEntry.relativePath !== rightEntry.relativePath || leftEntry.kind !== rightEntry.kind) {
      return { equal: false, evidence: `tree differs at ${leftEntry.relativePath}` };
    }
    if (leftEntry.mode !== rightEntry.mode) return { equal: false, evidence: `mode differs at ${leftEntry.relativePath}` };
    if (!leftEntry.contents.equals(rightEntry.contents)) return { equal: false, evidence: `content differs at ${leftEntry.relativePath}` };
  }
  return { equal: true };
}

async function copyTree(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    filter: (path) => !ignoredSkillArtifact(path),
  });
}

/** Atomically publish a new file without replacing an existing path or filesystem alias. */
export async function writeFileAtomicExclusive(path: string, contents: string | Buffer, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.overlord-${basename(path)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, mode === undefined ? undefined : { mode });
    if (mode !== undefined) await chmod(temporary, mode);
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Publish a validated skill tree without replacing any path that already exists. */
export async function copyDirectoryExclusive(source: string, destination: string): Promise<void> {
  if (await pathExists(destination)) {
    throw Object.assign(new Error(`Destination already exists: ${destination}`), { code: "EEXIST", path: destination });
  }
  const externalStage = await mkdtemp(join(tmpdir(), "overlord-stage-"));
  const stagedPayload = join(externalStage, "payload");
  let claimedDestination = false;
  try {
    await treeEntries(source);
    await copyTree(source, stagedPayload);
    const entries = await treeEntries(stagedPayload);
    const rootMode = (await lstat(stagedPayload)).mode & 0o777;
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(destination, { recursive: false, mode: 0o700 });
    claimedDestination = true;
    const directories = entries.filter((entry) => entry.kind === "directory");
    for (const entry of directories) {
      const path = join(destination, entry.relativePath);
      await mkdir(path, { recursive: false, mode: 0o700 });
    }
    for (const entry of entries) {
      const path = join(destination, entry.relativePath);
      if (entry.kind === "file") await writeFileAtomicExclusive(path, entry.contents, entry.mode);
    }
    for (const entry of [...directories].reverse()) {
      await chmod(join(destination, entry.relativePath), entry.mode);
    }
    await chmod(destination, rootMode);
  } catch (error) {
    if (claimedDestination && error !== null && typeof error === "object") {
      const carrier = error as { createdPaths?: unknown };
      const existing = Array.isArray(carrier.createdPaths) ? carrier.createdPaths : [];
      carrier.createdPaths = [destination, ...existing];
    }
    throw error;
  } finally {
    await rm(externalStage, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function displaceToBackup(path: string, artifactRoot: string): Promise<string> {
  const boundary = dirname(artifactRoot);
  const backupContainer = join(boundary, ".overlord-backups");
  const backupDirectory = join(backupContainer, randomUUID());
  const backup = join(backupDirectory, basename(path));
  await assertNoSymlinkedParent(backup, boundary);
  try {
    await mkdir(backupContainer, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const containerMetadata = await lstat(backupContainer);
  if (containerMetadata.isSymbolicLink() || !containerMetadata.isDirectory()) {
    throw Object.assign(new Error(`Backup root must be a physical directory: ${backupContainer}`), {
      code: "permission-denied",
      path: backupContainer,
    });
  }
  await mkdir(backupDirectory, { recursive: false, mode: 0o700 });
  await assertNoSymlinkedParent(backup, boundary);
  await rename(path, backup);
  return backup;
}

/** Atomically move an artifact out of its inventory root into a recoverable backup. */
export async function removeWithBackup(path: string, artifactRoot: string): Promise<string> {
  return displaceToBackup(path, artifactRoot);
}

/** Atomically displace a file, then exclusively publish its replacement. */
export async function replaceFileWithBackup(
  path: string,
  contents: string | Buffer,
  artifactRoot: string,
): Promise<string> {
  const backup = await displaceToBackup(path, artifactRoot);
  try {
    await writeFileAtomicExclusive(path, contents);
  } catch (error) {
    if (error !== null && typeof error === "object") {
      Object.assign(error, { createdBackups: [backup] });
    }
    throw error;
  }
  return backup;
}

export function lockPathForScope(scopePath: string): string {
  let physicalScope: string;
  try {
    physicalScope = realpathSync(scopePath);
  } catch {
    physicalScope = resolve(scopePath);
  }
  const digest = createHash("sha256").update(physicalScope).digest("hex").slice(0, 24);
  return join(tmpdir(), "overlord-locks", `${digest}.lock`);
}

async function lockOwnerIsStale(lockPath: string): Promise<boolean> {
  let owner: string;
  try {
    owner = await readFile(join(lockPath, "owner"), "utf8");
  } catch {
    // A missing owner can be the brief interval between mkdir and writeFile for
    // a live contender. Treat unknown ownership conservatively as active.
    return false;
  }
  const pid = Number.parseInt(owner.trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export async function acquireScopeLock(scopePath: string): Promise<() => Promise<void>> {
  const lockPath = lockPathForScope(scopePath);
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (await lockOwnerIsStale(lockPath)) {
        const displaced = `${lockPath}.stale-${randomUUID()}`;
        try {
          await rename(lockPath, displaced);
          await mkdir(lockPath);
        } catch {
          throw Object.assign(new Error(`Another Overlord mutation holds the scope lock: ${lockPath}`), { code: "lock-held", path: lockPath });
        } finally {
          await rm(displaced, { recursive: true, force: true }).catch(() => undefined);
        }
      } else {
        throw Object.assign(new Error(`Another Overlord mutation holds the scope lock: ${lockPath}`), { code: "lock-held", path: lockPath });
      }
    } else {
      throw error;
    }
  }
  try {
    await writeFile(join(lockPath, "owner"), `${process.pid}\n`);
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return async () => rm(lockPath, { recursive: true, force: true });
}
