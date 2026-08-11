import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

import { isPortableSkillName } from "./definitions.js";
import { IGNORED_SKILL_FILES, reservedSkillArtifact } from "./filesystem.js";
import { parseFrontmatter } from "./frontmatter.js";
import { parseClaudeAgent, parseCodexAgent } from "./render.js";
import type { TargetPaths } from "./targets.js";
import type { ArtifactKind, CanonicalAgent, TargetName } from "./types.js";

/** One supported definition found in a provider-native artifact root. */
export interface NativeDefinition {
  kind: ArtifactKind;
  name: string;
  target: TargetName;
  path: string;
  valid: boolean;
  agent?: CanonicalAgent;
  /** Original provider source, retained so reconciliation can preserve overlays. */
  source?: string;
  evidence?: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function ignoredArtifact(name: string): boolean {
  return IGNORED_SKILL_FILES.has(name) || name.startsWith("._");
}

async function directoryEntries(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw Object.assign(new Error(`Artifact root must be a physical directory: ${path}`), {
        code: "permission-denied",
        path,
      });
    }
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function nativeSkillTreeError(root: string): Promise<string | undefined> {
  let physicalRoot: string;
  try {
    physicalRoot = await realpath(root);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  async function walk(directory: string): Promise<string | undefined> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (ignoredArtifact(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        return `native skill contains unsupported symlink '${relative(physicalRoot, path)}'`;
      }
      if (reservedSkillArtifact(entry.name)) {
        return `native skill contains unsupported nested Git metadata '${relative(physicalRoot, path)}'`;
      }
      try {
        if (entry.isDirectory()) {
          const nested = await walk(path);
          if (nested !== undefined) return nested;
        } else if (entry.isFile()) {
          await readFile(path);
        } else {
          return `skill contains unsupported filesystem entry '${relative(physicalRoot, path)}'`;
        }
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
    return undefined;
  }

  return walk(physicalRoot);
}

async function scanSkillRoot(root: string): Promise<NativeDefinition[]> {
  const results: NativeDefinition[] = [];
  const entries = await directoryEntries(root);
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    if (ignoredArtifact(entry.name)) continue;
    const path = join(root, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      if (isPortableSkillName(entry.name)) {
        results.push({
          kind: "skill",
          name: entry.name,
          target: "claude",
          path,
          valid: false,
          evidence: "native skill destination must be a directory",
        });
      }
      continue;
    }
    if (entry.isSymbolicLink()) {
      results.push({
        kind: "skill",
        name: entry.name,
        target: "claude",
        path,
        valid: false,
        evidence: "native skill must be a physical directory",
      });
      continue;
    }

    let valid = isPortableSkillName(entry.name);
    let evidence: string | undefined;
    try {
      const skillFile = join(path, "SKILL.md");
      const parsed = parseFrontmatter(await readFile(skillFile, "utf8"), skillFile);
      if (
        parsed.attributes.name !== entry.name
        || typeof parsed.attributes.description !== "string"
        || parsed.attributes.description.trim().length === 0
        || parsed.attributes.description.length > 1_024
      ) {
        valid = false;
        evidence = "native skill frontmatter is not portable or does not match its directory";
      }
      if (valid) {
        const treeError = await nativeSkillTreeError(path);
        if (treeError !== undefined) {
          valid = false;
          evidence = treeError;
        }
      }
    } catch (error) {
      valid = false;
      evidence = error instanceof Error ? error.message : String(error);
    }

    const result: NativeDefinition = {
      kind: "skill",
      name: entry.name,
      target: "claude",
      path,
      valid,
    };
    if (evidence !== undefined) result.evidence = evidence;
    results.push(result);
  }
  return results;
}

async function scanAgentRoot(root: string, target: TargetName): Promise<NativeDefinition[]> {
  const paths: string[] = [];
  const unsupported: Array<{ path: string; evidence: string }> = [];

  if (target === "claude") {
    async function walk(directory: string): Promise<void> {
      const entries = await directoryEntries(directory);
      entries.sort((left, right) => compareText(left.name, right.name));
      for (const entry of entries) {
        if (ignoredArtifact(entry.name)) continue;
        const path = join(directory, entry.name);
        const extension = extname(entry.name);
        const agentExtension = extension.toLowerCase() === ".md";
        if (entry.isDirectory()) {
          if (agentExtension) unsupported.push({ path, evidence: "native agent destination must be a file" });
          await walk(path);
        } else if (agentExtension) {
          if (extension !== ".md") {
            unsupported.push({ path, evidence: "Claude agent must use the lowercase '.md' extension" });
          } else if (entry.isFile() || entry.isSymbolicLink()) {
            paths.push(path);
          } else {
            unsupported.push({ path, evidence: "native agent destination must be a file" });
          }
        }
      }
    }
    await walk(root);
  } else {
    const entries = await directoryEntries(root);
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (ignoredArtifact(entry.name)) continue;
      const extension = extname(entry.name);
      if (extension.toLowerCase() !== ".toml") continue;
      const path = join(root, entry.name);
      if (extension !== ".toml") {
        unsupported.push({ path, evidence: "Codex agent must use the lowercase '.toml' extension" });
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        paths.push(path);
      } else {
        unsupported.push({ path, evidence: "native agent destination must be a file" });
      }
    }
  }

  const results: NativeDefinition[] = unsupported.map(({ path, evidence }) => ({
    kind: "agent",
    name: basename(path, extname(path)),
    target,
    path,
    valid: false,
    evidence,
  }));

  for (const path of paths) {
    const expectedName = basename(path, extname(path));
    if ((await lstat(path)).isSymbolicLink()) {
      results.push({
        kind: "agent",
        name: expectedName,
        target,
        path,
        valid: false,
        evidence: "native agent must be a physical file",
      });
      continue;
    }

    let source: string | undefined;
    try {
      source = await readFile(path, "utf8");
      const agent = target === "claude"
        ? parseClaudeAgent(source, expectedName, path)
        : parseCodexAgent(source, expectedName, path);
      const result: NativeDefinition = {
        kind: "agent",
        name: expectedName,
        target,
        path,
        valid: agent.valid,
        agent,
        source,
      };
      if (!agent.valid) result.evidence = "native name is not portable or does not match its file";
      results.push(result);
    } catch (error) {
      const result: NativeDefinition = {
        kind: "agent",
        name: expectedName,
        target,
        path,
        valid: false,
        evidence: error instanceof Error ? error.message : String(error),
      };
      if (source !== undefined) result.source = source;
      results.push(result);
    }
  }
  return results;
}

/** Compare the provider-neutral identity and instructions of two agents. */
export function sameCommonAgent(left: CanonicalAgent, right: CanonicalAgent): boolean {
  const normalize = (value: string): string => `${value.replace(/\r\n?/g, "\n").replace(/\n+$/g, "")}\n`;
  return left.name === right.name
    && left.description === right.description
    && normalize(left.body) === normalize(right.body);
}

function definitionKey(definition: NativeDefinition): string {
  return `${definition.kind}:${definition.name}`;
}

/** Inventory only the provider roots Overlord supports. */
export async function scanNative(paths: TargetPaths): Promise<NativeDefinition[]> {
  const native = [
    ...await scanSkillRoot(paths.claude.skills),
    ...await scanAgentRoot(paths.claude.agents, "claude"),
    ...await scanAgentRoot(paths.codex.agents, "codex"),
  ];
  native.sort((left, right) => (
    compareText(definitionKey(left), definitionKey(right)) || compareText(left.path, right.path)
  ));
  return native;
}

function filesystemComparisonPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "darwin" ? absolute.normalize("NFD").toLowerCase() : absolute;
}

/** Find an inventoried definition at a provider output path. */
export function nativeAt(
  native: readonly NativeDefinition[],
  path: string,
): NativeDefinition | undefined {
  const expected = filesystemComparisonPath(path);
  return native.find((entry) => filesystemComparisonPath(entry.path) === expected);
}
