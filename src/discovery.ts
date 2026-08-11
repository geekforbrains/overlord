import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { Diagnostic, Scope } from "./types.js";

export interface DiscoverScopesOptions {
  home: string;
  roots: readonly string[];
}

export interface DiscoveryResult {
  scopes: Scope[];
  diagnostics: Diagnostic[];
  physicalPaths: Map<string, string>;
}

const ARTIFACT_ROOTS = [
  [".agents", "skills"],
  [".agents", "overlord", "agents"],
  [".claude", "skills"],
  [".claude", "agents"],
  [".codex", "skills"],
  [".codex", "agents"],
] as const;

const CONTROL_DIRECTORIES = new Set([".agents", ".claude", ".codex"]);
const PRUNED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".cache",
  ".venv",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function directoryKey(name: string): string {
  return process.platform === "darwin" ? name.normalize("NFD").toLowerCase() : name;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isAbsent(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Discover independent project scopes below explicitly configured boundaries.
 * Provider and canonical directories are inspected as markers but are never
 * traversed, and configured roots themselves are never returned as projects.
 */
export async function discoverScopes(options: DiscoverScopesOptions): Promise<DiscoveryResult> {
  const diagnostics: Diagnostic[] = [];
  const diagnosticKeys = new Set<string>();
  const configuredRoots = new Map<string, string>();

  function report(code: string, message: string, path: string): void {
    const key = `${code}\0${path}`;
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    diagnostics.push({ severity: "error", code, message, path });
  }

  for (const configuredPath of [...options.roots].sort(compareText)) {
    if (!isAbsolute(configuredPath)) {
      report("discovery-root-invalid", `Discovery root must be absolute: ${configuredPath}`, configuredPath);
      continue;
    }

    const absolutePath = resolve(configuredPath);
    try {
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        report("discovery-root-invalid", `Discovery root is not a physical directory: ${absolutePath}`, absolutePath);
        continue;
      }
      const physicalPath = await realpath(absolutePath);
      const existing = configuredRoots.get(physicalPath);
      if (existing === undefined || compareText(absolutePath, existing) < 0) {
        configuredRoots.set(physicalPath, absolutePath);
      }
    } catch (error) {
      report(
        "discovery-root-unavailable",
        `Cannot inspect discovery root '${absolutePath}': ${detail(error)}`,
        absolutePath,
      );
    }
  }

  const roots = [...configuredRoots.entries()]
    .map(([physicalPath, path]) => ({ physicalPath, path }))
    .sort((left, right) => compareText(left.path, right.path));
  const rootSet = new Set(configuredRoots.keys());
  const projects = new Map<string, Scope>();
  const visitedDirectories = new Set<string>();
  let physicalHome = resolve(options.home);
  try {
    physicalHome = await realpath(physicalHome);
  } catch {
    // The user scope is still emitted when home does not yet exist.
  }

  async function artifactRootHasEntries(directory: string, segments: readonly string[]): Promise<boolean> {
    let current = directory;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) return true;
      } catch (error) {
        if (isAbsent(error)) return false;
        report("discovery-unreadable", `Cannot inspect artifact directory '${current}': ${detail(error)}`, current);
        return false;
      }
    }

    try {
      return (await readdir(current)).length > 0;
    } catch (error) {
      if (isAbsent(error)) return false;
      report("discovery-unreadable", `Cannot read artifact directory '${current}': ${detail(error)}`, current);
      return false;
    }
  }

  async function containsArtifacts(directory: string): Promise<boolean> {
    for (const artifactRoot of ARTIFACT_ROOTS) {
      if (await artifactRootHasEntries(directory, artifactRoot)) return true;
    }
    return false;
  }

  async function walk(directory: string, discoveryRoot: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      report("discovery-unreadable", `Cannot read directory '${directory}': ${detail(error)}`, directory);
      return;
    }
    entries.sort((left, right) => compareText(left.name, right.name));

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryKey = directoryKey(entry.name);
      if (CONTROL_DIRECTORIES.has(entryKey) || PRUNED_DIRECTORIES.has(entryKey)) continue;

      const child = join(directory, entry.name);
      let physicalChild: string;
      try {
        const metadata = await lstat(child);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
        physicalChild = await realpath(child);
      } catch (error) {
        if (!isAbsent(error)) {
          report("discovery-unreadable", `Cannot inspect directory '${child}': ${detail(error)}`, child);
        }
        continue;
      }

      // A nested configured root owns its own traversal and is never itself a
      // project, even when an outer configured root also contains it.
      if (rootSet.has(physicalChild)) continue;
      if (visitedDirectories.has(physicalChild)) continue;
      visitedDirectories.add(physicalChild);

      if (physicalChild !== physicalHome && await containsArtifacts(child) && !projects.has(physicalChild)) {
        projects.set(physicalChild, {
          type: "project",
          path: child,
          canonical: join(child, ".agents"),
          discoveryRoot,
        });
      }
      await walk(child, discoveryRoot);
    }
  }

  for (const root of roots) {
    if (visitedDirectories.has(root.physicalPath)) continue;
    visitedDirectories.add(root.physicalPath);
    await walk(root.path, root.path);
  }

  const home = resolve(options.home);
  const userScope: Scope = { type: "user", path: home, canonical: join(home, ".agents") };
  const projectScopes = [...projects.values()].sort((left, right) => compareText(left.path, right.path));
  const physicalPaths = new Map<string, string>([[home, physicalHome]]);
  for (const [physicalPath, scope] of projects) physicalPaths.set(scope.path, physicalPath);
  diagnostics.sort((left, right) => compareText(left.path ?? "", right.path ?? "") || compareText(left.code ?? "", right.code ?? ""));
  return { scopes: [userScope, ...projectScopes], diagnostics, physicalPaths };
}
