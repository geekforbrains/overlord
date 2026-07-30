import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const temporaryDirectories: string[] = [];

export async function temporaryDirectory(prefix = "overlord-test-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

export async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

export async function writeText(path: string, contents: string, mode?: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, mode === undefined ? undefined : { mode });
}

export const validSkill = `---
name: verify-build
description: Verify a build using the project-specific launch recipe.
---

Run the documented build and report concrete failures.
`;

export const validAgent = `---
version: 1
name: reviewer
description: Reviews a change for correctness and missing tests.
targets:
  claude:
    color: cyan
    model: opus
    tools: [Read, Grep, Glob]
  codex:
    model_reasoning_effort: high
    sandbox_mode: read-only
---

Review the requested change. Lead with actionable findings.
`;
