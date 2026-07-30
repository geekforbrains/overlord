import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
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

export async function isDanglingSymlink(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) return false;
    try {
      await stat(path);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function symlinkResolvesTo(path: string, expected: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return false;
    const target = await readlink(path);
    return resolve(dirname(path), target) === resolve(expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface TreeEntry {
  relativePath: string;
  kind: "directory" | "file" | "symlink";
  mode: number;
  contents: Buffer;
}

async function treeEntries(root: string, current = root): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const children = await readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (ignoredSkillArtifact(child.name)) continue;
    const path = join(current, child.name);
    const relativePath = relative(root, path).split(sep).join("/");
    const info = await lstat(path);
    if (child.isDirectory()) {
      entries.push({ relativePath, kind: "directory", mode: info.mode & 0o777, contents: Buffer.alloc(0) });
      entries.push(...await treeEntries(root, path));
    } else if (child.isFile()) {
      entries.push({ relativePath, kind: "file", mode: info.mode & 0o777, contents: await readFile(path) });
    } else if (child.isSymbolicLink()) {
      const rawTarget = await readlink(path);
      const resolvedTarget = resolve(dirname(path), rawTarget);
      const relativeTarget = relative(root, resolvedTarget);
      if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
        throw Object.assign(new Error(`Symlink escapes skill directory: ${relativePath}`), { code: "permission-denied", path });
      }
      entries.push({ relativePath, kind: "symlink", mode: info.mode & 0o777, contents: Buffer.from(rawTarget) });
    }
  }
  return entries;
}

export async function assertNoSymlinkedParent(destination: string, boundary: string): Promise<void> {
  const absoluteDestination = resolve(destination);
  const absoluteBoundary = resolve(boundary);
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
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    filter: (path) => !ignoredSkillArtifact(path),
  });
}

export async function writeFileAtomic(path: string, contents: string | Buffer, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.overlord-${basename(path)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, mode === undefined ? undefined : { mode });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function copyDirectoryAtomic(source: string, destination: string): Promise<void> {
  const externalStage = await mkdtemp(join(tmpdir(), "overlord-stage-"));
  const stagedPayload = join(externalStage, "payload");
  const siblingStage = join(dirname(destination), `.overlord-${basename(destination)}-${randomUUID()}.tmp`);
  try {
    await copyTree(source, stagedPayload);
    await mkdir(dirname(destination), { recursive: true });
    await copyTree(stagedPayload, siblingStage);
    await rename(siblingStage, destination);
  } finally {
    await rm(siblingStage, { recursive: true, force: true }).catch(() => undefined);
    await rm(externalStage, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function createBackup(path: string): Promise<string> {
  const backupRoot = await mkdtemp(join(tmpdir(), "overlord-backup-"));
  const destination = join(backupRoot, basename(path));
  const info = await lstat(path);
  if (info.isDirectory() && !info.isSymbolicLink()) await copyTree(path, destination);
  else if (info.isSymbolicLink()) await symlinkClone(path, destination);
  else await cp(path, destination, { preserveTimestamps: true });
  return destination;
}

async function symlinkClone(source: string, destination: string): Promise<void> {
  const target = await readlink(source);
  const { symlink } = await import("node:fs/promises");
  await symlink(target, destination);
}

export async function replaceDirectoryWithBackup(source: string, destination: string): Promise<string> {
  const backup = await createBackup(destination);
  const displaced = join(dirname(destination), `.overlord-${basename(destination)}-${randomUUID()}.old`);
  try {
    await rename(destination, displaced);
    await copyDirectoryAtomic(source, destination);
    await rm(displaced, { recursive: true, force: true });
    return backup;
  } catch (error) {
    if (!(await pathExists(destination)) && await pathExists(displaced)) await rename(displaced, destination).catch(() => undefined);
    throw error;
  }
}

export async function removeWithBackup(path: string): Promise<string> {
  const backup = await createBackup(path);
  try {
    await rm(path, { recursive: true, force: false });
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
