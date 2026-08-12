import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { synchronize } from "../src/engine.js";
import { removalApprovalKey } from "../src/removals.js";
import type { EngineOptions } from "../src/types.js";
import {
  cleanupTemporaryDirectories,
  prepareUserRepository,
  temporaryDirectory,
  validSkill,
  writeText,
} from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

describe("synchronization removal policy", () => {
  it("holds an unapproved removal and executes the same locked-inventory action after approval", async () => {
    const home = await temporaryDirectory();
    const projects = await temporaryDirectory();
    const project = join(projects, "project");
    const canonical = join(project, ".agents/skills/verify-build");
    const claude = join(project, ".claude/skills/verify-build");
    const options: EngineOptions = {
      home,
      env: {
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
      },
    };
    await writeText(join(home, ".agents/overlord/overlord.yaml"), `roots:\n  - ${projects}\n`);
    await prepareUserRepository(home);
    await writeText(join(canonical, "SKILL.md"), validSkill);
    expect((await synchronize(options)).status).toBe("ok");

    await rm(canonical, { recursive: true });
    const held = await synchronize(options, { approvedRemovalActions: new Set() });
    const removal = held.actions?.find((action) => action.status === "planned" && action.removes?.includes(claude));

    expect(removal).toBeDefined();
    expect((await lstat(claude)).isDirectory()).toBe(true);
    const key = removal === undefined ? undefined : removalApprovalKey(removal);
    expect(key).toBeDefined();

    const approved = await synchronize(options, {
      approvedRemovalActions: new Set(key === undefined ? [] : [key]),
    });

    expect(approved.actions).toContainEqual(expect.objectContaining({
      status: "completed",
      removes: [claude],
    }));
    await expect(lstat(claude)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds user-source removal and commits it only after approval", async () => {
    const home = await temporaryDirectory();
    const canonical = join(home, ".agents/skills/verify-build");
    const claude = join(home, ".claude/skills/verify-build");
    const options: EngineOptions = {
      home,
      env: {
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
      },
    };
    await writeText(join(home, ".agents/overlord/overlord.yaml"), "roots: []\n");
    await prepareUserRepository(home);
    await writeText(join(canonical, "SKILL.md"), validSkill);
    expect((await synchronize(options)).status).toBe("ok");

    await rm(claude, { recursive: true });
    const held = await synchronize(options, { approvedRemovalActions: new Set() });
    const removal = held.actions?.find((action) => action.status === "planned" && action.removes?.includes(canonical));

    expect(removal).toBeDefined();
    expect((await lstat(canonical)).isDirectory()).toBe(true);
    const key = removal === undefined ? undefined : removalApprovalKey(removal);
    const approved = await synchronize(options, {
      approvedRemovalActions: new Set(key === undefined ? [] : [key]),
    });

    expect(approved.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "completed", removes: [canonical] }),
      expect.objectContaining({ status: "completed", commit: expect.any(Object) }),
    ]));
    await expect(lstat(canonical)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
