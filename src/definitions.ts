import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

import { parseFrontmatter } from "./frontmatter.js";
import type {
  CanonicalAgent,
  CanonicalScope,
  CanonicalSkill,
  Diagnostic,
  SkillFile,
  TargetName,
  TargetOverlay,
} from "./types.js";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_NAME = /^[a-z]+(?:-[a-z]+)*$/;

/** Entries produced by the operating system rather than authored skill data. */
const IGNORED_ARTIFACT_NAMES = new Set([
  ".DS_Store",
  "Desktop.ini",
  "Thumbs.db",
  "ehthumbs.db",
]);

const CLAUDE_OVERLAY_FIELDS = new Set([
  "background",
  "color",
  "disallowedTools",
  "effort",
  "hooks",
  "initialPrompt",
  "isolation",
  "maxTurns",
  "mcpServers",
  "memory",
  "model",
  "permissionMode",
  "skills",
  "tools",
]);

const CODEX_OVERLAY_FIELDS = new Set([
  "approval_policy",
  "features",
  "mcp_servers",
  "model",
  "model_context_window",
  "model_provider",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "personality",
  "sandbox_mode",
  "sandbox_workspace_write",
  "skills",
  "tools",
  "web_search",
]);

const RESERVED_OVERLAY_FIELDS: Readonly<Record<TargetName, ReadonlySet<string>>> = {
  claude: new Set(["name", "description"]),
  codex: new Set(["name", "description", "developer_instructions"]),
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isPortableSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && SKILL_NAME.test(name);
}

export function isPortableAgentName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && AGENT_NAME.test(name);
}

function diagnostic(
  diagnostics: Diagnostic[],
  severity: Diagnostic["severity"],
  code: string,
  message: string,
  path: string,
  suggestion?: string,
): void {
  const entry: Diagnostic = { severity, code, message, path };
  if (suggestion !== undefined) entry.suggestion = suggestion;
  diagnostics.push(entry);
}

function ignoredArtifact(name: string): boolean {
  return IGNORED_ARTIFACT_NAMES.has(name) || name.startsWith("._");
}

interface SkillInventory {
  files: SkillFile[];
  directories: string[];
  valid: boolean;
}

async function inventorySkill(
  root: string,
  diagnostics: Diagnostic[],
): Promise<SkillInventory> {
  const files: SkillFile[] = [];
  const directories: string[] = [];
  let valid = true;

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      valid = false;
      diagnostic(
        diagnostics,
        "error",
        "unreadable-skill",
        `Cannot read skill directory: ${error instanceof Error ? error.message : String(error)}`,
        directory,
      );
      return;
    }

    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath);
      if (entry.isSymbolicLink()) {
        valid = false;
        diagnostic(
          diagnostics,
          "error",
          "unsupported-skill-symlink",
          `Skill contains symlink '${relativePath}'; symlinks are not supported.`,
          absolutePath,
        );
        continue;
      }
      if (ignoredArtifact(entry.name)) continue;

      if (entry.isDirectory()) {
        directories.push(relativePath);
        await walk(absolutePath);
        continue;
      }

      try {
        const metadata = await lstat(absolutePath);
        if (entry.isFile()) {
          files.push({
            relativePath,
            path: absolutePath,
            mode: metadata.mode & 0o777,
            contents: await readFile(absolutePath),
          });
        } else {
          valid = false;
          diagnostic(
            diagnostics,
            "error",
            "unsupported-skill-entry",
            `Skill contains unsupported filesystem entry '${relativePath}'.`,
            absolutePath,
          );
        }
      } catch (error) {
        valid = false;
        diagnostic(
          diagnostics,
          "error",
          "unreadable-skill-file",
          `Cannot inspect skill file '${relativePath}': ${error instanceof Error ? error.message : String(error)}`,
          absolutePath,
        );
      }
    }
  }

  await walk(root);
  files.sort((left, right) => compareText(left.relativePath, right.relativePath));
  directories.sort(compareText);
  return { files, directories, valid };
}

async function loadSkill(
  directory: string,
  diagnostics: Diagnostic[],
): Promise<CanonicalSkill> {
  const directoryName = basename(directory);
  const skillFile = join(directory, "SKILL.md");
  try {
    if ((await lstat(directory)).isSymbolicLink()) {
      diagnostic(
        diagnostics,
        "error",
        "unsupported-canonical-symlink",
        "A canonical skill must be a real directory inside .agents; top-level definition symlinks are not supported.",
        directory,
      );
      return {
        name: directoryName,
        description: "",
        body: "",
        path: directory,
        skillFile,
        attributes: {},
        files: [],
        directories: [],
        valid: false,
      };
    }
  } catch (error) {
    diagnostic(
      diagnostics,
      "error",
      "unreadable-skill",
      `Cannot inspect canonical skill directory: ${error instanceof Error ? error.message : String(error)}`,
      directory,
    );
    return {
      name: directoryName,
      description: "",
      body: "",
      path: directory,
      skillFile,
      attributes: {},
      files: [],
      directories: [],
      valid: false,
    };
  }
  const inventory = await inventorySkill(directory, diagnostics);
  let attributes: Record<string, unknown> = {};
  let body = "";
  let valid = inventory.valid;

  try {
    const source = await readFile(skillFile, "utf8");
    ({ attributes, body } = parseFrontmatter(source, skillFile));
  } catch (error) {
    valid = false;
    const missing = isMissing(error);
    diagnostic(
      diagnostics,
      "error",
      missing ? "missing-skill-file" : "invalid-frontmatter",
      missing
        ? "Skill directory is missing SKILL.md."
        : error instanceof Error ? error.message : String(error),
      skillFile,
    );
  }

  const declaredName = stringField(attributes.name);
  const name = declaredName ?? directoryName;
  const declaredDescription = stringField(attributes.description);
  const description = declaredDescription ?? "";

  if (declaredName === undefined || declaredName.length === 0) {
    valid = false;
    diagnostic(diagnostics, "error", "missing-required-field", "Skill frontmatter requires a string 'name'.", skillFile);
  } else if (!isPortableSkillName(declaredName)) {
    valid = false;
    diagnostic(
      diagnostics,
      "error",
      "non-portable-name",
      `Skill name '${declaredName}' is not portable; use 1-64 lowercase letters, digits, and single hyphens.`,
      skillFile,
    );
  }

  if (declaredName !== undefined && declaredName !== directoryName) {
    valid = false;
    diagnostic(
      diagnostics,
      "error",
      "name-path-mismatch",
      `Skill directory name '${directoryName}' must equal frontmatter name '${declaredName}'.`,
      skillFile,
    );
  }

  if (declaredDescription === undefined || declaredDescription.trim().length === 0) {
    valid = false;
    diagnostic(
      diagnostics,
      "error",
      "missing-required-field",
      "Skill frontmatter requires a non-empty string 'description'.",
      skillFile,
    );
  } else if (declaredDescription.length > 1_024) {
    valid = false;
    diagnostic(
      diagnostics,
      "error",
      "field-too-long",
      "Skill frontmatter 'description' must be at most 1024 characters.",
      skillFile,
    );
  }

  return {
    name,
    description,
    body,
    path: directory,
    skillFile,
    attributes,
    files: inventory.files,
    directories: inventory.directories,
    valid,
  };
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        substitution,
      );
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index]!;
  }
  return previous[right.length]!;
}

function closestField(field: string, known: ReadonlySet<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const distance = editDistance(field, candidate);
    if (distance < bestDistance || (distance === bestDistance && best !== undefined && candidate < best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const threshold = field.length <= 4 ? 1 : 2;
  return bestDistance <= threshold ? best : undefined;
}

function validateOverlay(
  agentName: string,
  target: TargetName,
  overlay: TargetOverlay,
  path: string,
  diagnostics: Diagnostic[],
): boolean {
  let valid = true;
  const known = target === "claude" ? CLAUDE_OVERLAY_FIELDS : CODEX_OVERLAY_FIELDS;
  for (const field of Object.keys(overlay).sort(compareText)) {
    if (RESERVED_OVERLAY_FIELDS[target].has(field)) {
      valid = false;
      diagnostic(
        diagnostics,
        "error",
        "reserved-overlay-field",
        `Agent '${agentName}' field '${field}' for target ${target} is supplied by the common definition and cannot be overridden.`,
        path,
      );
      continue;
    }
    if (known.has(field)) continue;

    diagnostic(
      diagnostics,
      "warning",
      "unknown-overlay-field",
      `Agent '${agentName}' has unknown field '${field}' for target ${target}; passing it through unchanged.`,
      path,
      closestField(field, known),
    );
  }
  return valid;
}

function targetOverlay(
  value: unknown,
  target: TargetName,
  path: string,
  diagnostics: Diagnostic[],
): TargetOverlay | false {
  if (value === undefined) return {};
  if (value === false) return false;
  if (isRecord(value)) return value;
  diagnostic(
    diagnostics,
    "error",
    "invalid-target-overlay",
    `Agent target '${target}' must be a mapping or false.`,
    path,
  );
  return {};
}

async function loadAgent(
  path: string,
  diagnostics: Diagnostic[],
): Promise<CanonicalAgent> {
  const extension = extname(path);
  const fileStem = basename(path, extension);
  const portableExtension = extension === ".md";
  if (!portableExtension) {
    diagnostic(
      diagnostics,
      "error",
      "non-portable-agent-extension",
      `Canonical agent '${basename(path)}' must use the lowercase '.md' extension.`,
      path,
    );
  }
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      diagnostic(
        diagnostics,
        "error",
        "unsupported-canonical-symlink",
        "A canonical agent must be a real Markdown file inside .agents; top-level definition symlinks are not supported.",
        path,
      );
      return {
        version: 1,
        name: fileStem,
        description: "",
        body: "",
        path,
        valid: false,
        targets: { claude: {}, codex: {} },
      };
    }
  } catch (error) {
    diagnostic(
      diagnostics,
      "error",
      "unreadable-agent",
      `Cannot inspect canonical agent: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
    return {
      version: 1,
      name: fileStem,
      description: "",
      body: "",
      path,
      valid: false,
      targets: { claude: {}, codex: {} },
    };
  }
  let attributes: Record<string, unknown> = {};
  let body = "";
  let valid = portableExtension;

  try {
    ({ attributes, body } = parseFrontmatter(await readFile(path, "utf8"), path));
  } catch (error) {
    valid = false;
    diagnostic(
      diagnostics,
      "error",
      isMissing(error) ? "missing-agent-file" : "invalid-frontmatter",
      error instanceof Error ? error.message : String(error),
      path,
    );
  }

  const declaredName = stringField(attributes.name);
  const name = declaredName ?? fileStem;
  const declaredDescription = stringField(attributes.description);
  const description = declaredDescription ?? "";

  if (attributes.version !== 1) {
    valid = false;
    diagnostic(diagnostics, "error", "unsupported-version", "Canonical agent 'version' must be 1.", path);
  }
  if (declaredName === undefined || declaredName.length === 0) {
    valid = false;
    diagnostic(diagnostics, "error", "missing-required-field", "Agent frontmatter requires a string 'name'.", path);
  } else if (!isPortableAgentName(declaredName)) {
    valid = false;
    diagnostic(
      diagnostics,
      "error",
      "non-portable-name",
      `Agent name '${declaredName}' is not portable; use 1-64 lowercase letters and single hyphens.`,
      path,
    );
  }
  if (declaredName !== undefined && declaredName !== fileStem) {
    valid = false;
    diagnostic(
      diagnostics,
      "error",
      "name-path-mismatch",
      `Agent file name '${fileStem}.md' must equal frontmatter name '${declaredName}'.`,
      path,
    );
  }
  if (declaredDescription === undefined || declaredDescription.trim().length === 0) {
    valid = false;
    diagnostic(diagnostics, "error", "missing-required-field", "Agent frontmatter requires a non-empty string 'description'.", path);
  }
  if (body.trim().length === 0) {
    valid = false;
    diagnostic(diagnostics, "error", "missing-instructions", "Canonical agent requires a non-empty Markdown body.", path);
  }

  const topLevelFields = new Set(["version", "name", "description", "targets"]);
  for (const field of Object.keys(attributes).sort(compareText)) {
    if (!topLevelFields.has(field)) {
      valid = false;
      diagnostic(
        diagnostics,
        "error",
        "unknown-canonical-field",
        `Unknown canonical agent field '${field}'; native settings belong below 'targets'.`,
        path,
      );
    }
  }

  let targetValues: Record<string, unknown> = {};
  if (attributes.targets !== undefined) {
    if (isRecord(attributes.targets)) {
      targetValues = attributes.targets;
      for (const target of Object.keys(targetValues).sort(compareText)) {
        if (target !== "claude" && target !== "codex") {
          valid = false;
          diagnostic(diagnostics, "error", "unknown-target", `Unknown agent target '${target}'.`, path);
        }
      }
    } else {
      valid = false;
      diagnostic(diagnostics, "error", "invalid-targets", "Agent 'targets' must be a mapping.", path);
    }
  }

  const claude = targetOverlay(targetValues.claude, "claude", path, diagnostics);
  const codex = targetOverlay(targetValues.codex, "codex", path, diagnostics);
  if (targetValues.claude !== undefined && targetValues.claude !== false && !isRecord(targetValues.claude)) valid = false;
  if (targetValues.codex !== undefined && targetValues.codex !== false && !isRecord(targetValues.codex)) valid = false;
  if (claude !== false && !validateOverlay(name, "claude", claude, path, diagnostics)) valid = false;
  if (codex !== false && !validateOverlay(name, "codex", codex, path, diagnostics)) valid = false;

  return {
    version: 1,
    name,
    description,
    body,
    path,
    valid,
    targets: { claude, codex },
  };
}

async function childDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => !ignoredArtifact(entry.name))
      .map((entry) => join(path, entry.name))
      .sort(compareText);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function agentFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => extname(entry.name).toLowerCase() === ".md" && !ignoredArtifact(entry.name))
      .map((entry) => join(path, entry.name))
      .sort(compareText);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function physicalCanonicalDirectory(
  path: string,
  label: string,
  diagnostics: Diagnostic[],
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) return true;
    diagnostic(
      diagnostics,
      "error",
      "invalid-canonical-root",
      `${label} must be a physical directory inside the scope.`,
      path,
    );
    return false;
  } catch (error) {
    if (isMissing(error)) return false;
    diagnostic(
      diagnostics,
      "error",
      "unreadable-canonical-root",
      `Cannot inspect ${label}: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
    return false;
  }
}

/** Load and validate all canonical definitions in one `.agents` directory. */
export async function loadCanonicalScope(
  canonicalRoot: string,
): Promise<CanonicalScope> {
  const diagnostics: Diagnostic[] = [];
  const skills: CanonicalSkill[] = [];
  const agents: CanonicalAgent[] = [];

  if (!(await physicalCanonicalDirectory(canonicalRoot, "canonical root", diagnostics))) {
    return { skills, agents, diagnostics };
  }
  const skillRoot = join(canonicalRoot, "skills");
  if (await physicalCanonicalDirectory(skillRoot, "canonical skills root", diagnostics)) {
    for (const directory of await childDirectories(skillRoot)) skills.push(await loadSkill(directory, diagnostics));
  }
  const overlordRoot = join(canonicalRoot, "overlord");
  if (await physicalCanonicalDirectory(overlordRoot, "canonical Overlord root", diagnostics)) {
    const agentRoot = join(overlordRoot, "agents");
    if (await physicalCanonicalDirectory(agentRoot, "canonical agents root", diagnostics)) {
      for (const path of await agentFiles(agentRoot)) agents.push(await loadAgent(path, diagnostics));
    }
  }

  skills.sort((left, right) => compareText(left.name, right.name) || compareText(left.path, right.path));
  agents.sort((left, right) => compareText(left.name, right.name) || compareText(left.path, right.path));
  return { skills, agents, diagnostics };
}
