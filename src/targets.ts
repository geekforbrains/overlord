import { isAbsolute, join, resolve } from "node:path";

import type { EngineOptions, Scope } from "./types.js";

export interface TargetPaths {
  claude: { skills: string; agents: string };
  codex: { agents: string };
}

/** Claude owns these skill-root entries, including case aliases on any filesystem. */
export function isClaudeOwnedSkillName(name: string): boolean {
  return name.toLowerCase() === "synced" || name.toLowerCase() === ".trash";
}

function userTargetRoot(value: string | undefined, fallback: string, home: string): string {
  if (value === undefined || value.length === 0) return fallback;
  return isAbsolute(value) ? resolve(value) : resolve(home, value);
}

/** Resolve filesystem locations without depending on the current directory or executable PATH. */
export function resolveTargetPaths(scope: Scope, options: EngineOptions): TargetPaths {
  if (scope.type === "project") {
    return {
      claude: {
        skills: join(scope.path, ".claude", "skills"),
        agents: join(scope.path, ".claude", "agents"),
      },
      codex: { agents: join(scope.path, ".codex", "agents") },
    };
  }

  const claudeRoot = userTargetRoot(options.env.CLAUDE_CONFIG_DIR, join(options.home, ".claude"), options.home);
  const codexRoot = userTargetRoot(options.env.CODEX_HOME, join(options.home, ".codex"), options.home);
  return {
    claude: { skills: join(claudeRoot, "skills"), agents: join(claudeRoot, "agents") },
    codex: { agents: join(codexRoot, "agents") },
  };
}
