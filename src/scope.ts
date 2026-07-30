import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Scope } from "./types.js";

export type ScopeType = "user" | "project";

export type ScopeResolutionMethod =
  | "explicit-flag"
  | "nearest-ancestor"
  | "git-worktree-root"
  | "user-default";

export interface ResolveScopeOptions {
  cwd: string;
  home: string;
  global?: boolean;
  project?: string;
}

export type ResolvedScope = Scope;

export type ScopeResolutionErrorCode = "usage" | "scope-unresolvable";

export interface ScopeResolutionErrorOptions {
  path?: string;
  detail?: string;
  cause?: unknown;
}

/** A scope-selection error suitable for direct CLI error serialization. */
export class ScopeResolutionError extends Error {
  readonly code: ScopeResolutionErrorCode;
  readonly path?: string;
  readonly detail?: string;

  constructor(code: ScopeResolutionErrorCode, message: string, options: ScopeResolutionErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "ScopeResolutionError";
    this.code = code;
    if (options.path !== undefined) this.path = options.path;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

function scope(
  type: ScopeType,
  root: string,
  resolvedBy: ScopeResolutionMethod,
  evidence: string,
): Scope {
  return {
    type,
    path: root,
    canonical: join(root, ".agents"),
    resolvedBy,
    evidence,
  };
}

function parentDirectories(start: string): string[] {
  const directories: string[] = [];
  let current = start;

  while (true) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return directories;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw inspectionError(path, error);
  }
}

async function isGitMarker(path: string): Promise<boolean> {
  try {
    const marker = await stat(path);
    return marker.isDirectory() || marker.isFile();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw inspectionError(path, error);
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function inspectionError(path: string, cause: unknown): ScopeResolutionError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ScopeResolutionError("scope-unresolvable", `Unable to inspect scope marker at ${path}`, {
    path,
    detail,
    cause,
  });
}

/**
 * Select one canonical scope without walking any descendants of the working
 * directory. Project discovery is deliberately filesystem-based so linked
 * worktrees, whose `.git` marker is a file, work without invoking Git.
 */
export async function resolveScope(options: ResolveScopeOptions): Promise<Scope> {
  if (options.global === true && options.project !== undefined) {
    throw new ScopeResolutionError("usage", "--global and --project cannot be used together");
  }

  const cwd = resolve(options.cwd);
  const home = resolve(options.home);

  if (options.global === true) {
    return scope("user", home, "explicit-flag", "--global");
  }

  if (options.project !== undefined) {
    if (options.project.length === 0) {
      throw new ScopeResolutionError("usage", "--project requires a path");
    }

    const project = resolve(cwd, options.project);
    return scope("project", project, "explicit-flag", project);
  }

  const ancestors = parentDirectories(cwd);

  for (const ancestor of ancestors) {
    // ~/.agents is the user source, not a project discovered above a working
    // directory. It remains the final fallback after Git-root discovery.
    if (ancestor === home) continue;

    const canonical = join(ancestor, ".agents");
    if (await isDirectory(canonical)) {
      return scope("project", ancestor, "nearest-ancestor", canonical);
    }
  }

  for (const ancestor of ancestors) {
    const marker = join(ancestor, ".git");
    if (await isGitMarker(marker)) {
      return scope("project", ancestor, "git-worktree-root", marker);
    }
  }

  return scope("user", home, "user-default", join(home, ".agents"));
}
