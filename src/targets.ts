import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { Availability, EngineOptions, Scope, TargetName, TargetRecord } from "./types.js";

export interface TargetPaths {
  claude: { skills: string; agents: string; commands: string };
  codex: { skills: string; agents: string };
}

function commandPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function detectOne(name: TargetName, env: NodeJS.ProcessEnv): { available: boolean; version: string | null } {
  const executable = commandPath(name, env);
  if (executable === undefined) return { available: false, version: null };
  const result = spawnSync(executable, ["--version"], { env, encoding: "utf8", timeout: 5_000 });
  if (result.error !== undefined || result.status !== 0) return { available: false, version: null };
  return { available: true, version: (result.stdout || result.stderr).trim() || null };
}

export function resolveAvailability(options: EngineOptions): Availability {
  if (options.availability !== undefined) return options.availability;
  const env = { ...process.env, ...options.env };
  return { claude: detectOne("claude", env), codex: detectOne("codex", env) };
}

export function resolveTargetPaths(scope: Scope, options: EngineOptions): TargetPaths {
  const env = options.env ?? {};
  if (scope.type === "project") {
    return {
      claude: {
        skills: join(scope.path, ".claude", "skills"),
        agents: join(scope.path, ".claude", "agents"),
        commands: join(scope.path, ".claude", "commands"),
      },
      codex: {
        skills: join(scope.path, ".codex", "skills"),
        agents: join(scope.path, ".codex", "agents"),
      },
    };
  }
  const claudeRoot = resolve(options.cwd, env.CLAUDE_CONFIG_DIR || join(options.home, ".claude"));
  const codexRoot = resolve(options.cwd, env.CODEX_HOME || join(options.home, ".codex"));
  return {
    claude: { skills: join(claudeRoot, "skills"), agents: join(claudeRoot, "agents"), commands: join(claudeRoot, "commands") },
    codex: { skills: join(codexRoot, "skills"), agents: join(codexRoot, "agents") },
  };
}

export function targetRecords(availability: Availability, paths: TargetPaths): TargetRecord[] {
  return (["claude", "codex"] as const).map((name) => ({
    name,
    available: availability[name].available,
    version: availability[name].version,
    paths: name === "claude"
      ? { skills: paths.claude.skills, agents: paths.claude.agents }
      : { skills: paths.codex.skills, agents: paths.codex.agents },
    observability: ["Built-in, plugin, organization-managed, and session-only definitions are outside Overlord's filesystem inventory."],
  }));
}
