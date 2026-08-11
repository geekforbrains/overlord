import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  LedgerFormatError,
  deleteLedgerEntry,
  digestFile,
  digestSkillTree,
  emptyScopeLedger,
  getLedgerEntry,
  ledgerPath,
  loadScopeLedger,
  physicalScopeIdentity,
  saveScopeLedger,
  setLedgerEntry,
} from "../src/ledger.js";
import { cleanupTemporaryDirectories, temporaryDirectory, writeText } from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

function fakeDigest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function receipt(path: string, character: string) {
  return { path, digest: fakeDigest(character) };
}

describe("scope ledger", () => {
  it("loads a missing ledger without creating state", async () => {
    const root = await temporaryDirectory();
    const userCanonical = join(root, ".agents");
    const scope = join(root, "project");
    await mkdir(userCanonical, { recursive: true });
    await mkdir(scope);
    const scopeIdentity = await physicalScopeIdentity(scope);
    const path = ledgerPath(userCanonical, scopeIdentity);

    await expect(loadScopeLedger(userCanonical, scopeIdentity)).resolves.toEqual(emptyScopeLedger(scopeIdentity));
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(userCanonical, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("saves deterministic JSON atomically and round-trips entries", async () => {
    const root = await temporaryDirectory();
    const userCanonical = join(root, ".agents");
    const scope = join(root, "project");
    await mkdir(join(userCanonical, ".git"), { recursive: true });
    await mkdir(scope);
    const scopeIdentity = await physicalScopeIdentity(scope);
    const ledger = emptyScopeLedger(scopeIdentity);

    setLedgerEntry(ledger, { scopeIdentity, kind: "skill", name: "zebra" }, {
      receipts: {
        codex: receipt(join(scope, ".agents/skills/zebra"), "3"),
        canonical: receipt(join(scope, ".agents/skills/zebra"), "1"),
        claude: receipt(join(scope, ".claude/skills/zebra"), "2"),
      },
    });
    setLedgerEntry(ledger, { scopeIdentity, kind: "agent", name: "alpha" }, {
      receipts: {
        codex: receipt(join(scope, ".codex/agents/alpha.toml"), "5"),
        canonical: receipt(join(scope, ".agents/overlord/agents/alpha.md"), "4"),
      },
      canonicalSource: "---\nname: alpha\n---\n\nAlpha.\n",
    });
    setLedgerEntry(ledger, { scopeIdentity, kind: "skill", name: "alpha" }, {
      receipts: {
        claude: receipt(join(scope, ".claude/skills/alpha"), "7"),
        canonical: receipt(join(scope, ".agents/skills/alpha"), "6"),
      },
    });

    await saveScopeLedger(userCanonical, ledger);
    const path = ledgerPath(userCanonical, scopeIdentity);
    const first = await readFile(path, "utf8");
    const loaded = await loadScopeLedger(userCanonical, scopeIdentity);
    await saveScopeLedger(userCanonical, loaded);
    const second = await readFile(path, "utf8");

    expect(second).toBe(first);
    expect(loaded).toEqual(ledger);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.indexOf('"agent"')).toBeLessThan(first.indexOf('"skill"'));
    expect(first.indexOf('"alpha"')).toBeLessThan(first.indexOf('"zebra"'));
    const parsed = JSON.parse(first) as {
      entries: { skill: { zebra: { receipts: Record<string, unknown> } } };
    };
    expect(Object.keys(parsed.entries.skill.zebra.receipts)).toEqual(["canonical", "claude", "codex"]);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(readdir(dirname(path))).resolves.toEqual([basename(path)]);
  });

  it("isolates identical definition names by physical scope identity", async () => {
    const root = await temporaryDirectory();
    const userCanonical = join(root, ".agents");
    const firstScope = join(root, "first");
    const secondScope = join(root, "second");
    const firstAlias = join(root, "first-alias");
    await mkdir(firstScope);
    await mkdir(secondScope);
    await mkdir(join(userCanonical, ".git"), { recursive: true });
    await symlink(firstScope, firstAlias);
    const firstIdentity = await physicalScopeIdentity(firstScope);
    const secondIdentity = await physicalScopeIdentity(secondScope);

    expect(await physicalScopeIdentity(firstAlias)).toBe(firstIdentity);
    expect(ledgerPath(userCanonical, firstIdentity)).not.toBe(ledgerPath(userCanonical, secondIdentity));
    expect(basename(ledgerPath(userCanonical, firstIdentity))).toBe(
      `${createHash("sha256").update(firstIdentity).digest("hex")}.json`,
    );

    const firstLedger = emptyScopeLedger(firstIdentity);
    const secondLedger = emptyScopeLedger(secondIdentity);
    const firstKey = { scopeIdentity: firstIdentity, kind: "skill", name: "shared" } as const;
    const secondKey = { scopeIdentity: secondIdentity, kind: "skill", name: "shared" } as const;
    setLedgerEntry(firstLedger, firstKey, {
      receipts: { canonical: receipt(join(firstScope, ".agents/skills/shared"), "a") },
    });
    setLedgerEntry(secondLedger, secondKey, {
      receipts: { canonical: receipt(join(secondScope, ".agents/skills/shared"), "b") },
    });
    await saveScopeLedger(userCanonical, firstLedger);
    await saveScopeLedger(userCanonical, secondLedger);

    expect(getLedgerEntry(await loadScopeLedger(userCanonical, firstIdentity), firstKey)?.receipts.canonical?.digest)
      .toBe(fakeDigest("a"));
    expect(getLedgerEntry(await loadScopeLedger(userCanonical, secondIdentity), secondKey)?.receipts.canonical?.digest)
      .toBe(fakeDigest("b"));
    expect(deleteLedgerEntry(firstLedger, firstKey)).toBe(true);
    expect(deleteLedgerEntry(firstLedger, firstKey)).toBe(false);
    expect(getLedgerEntry(firstLedger, firstKey)).toBeUndefined();
    expect(() => getLedgerEntry(firstLedger, secondKey)).toThrow(/scope identity/i);
  });

  it("rejects ledger metadata redirected through a symlinked parent", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const userCanonical = join(root, ".agents");
    const scope = join(root, "project");
    await mkdir(join(userCanonical, ".git"), { recursive: true });
    await mkdir(scope);
    await symlink(outside, join(userCanonical, ".git/overlord"));
    const scopeIdentity = await physicalScopeIdentity(scope);
    const ledger = emptyScopeLedger(scopeIdentity);
    const path = ledgerPath(userCanonical, scopeIdentity);
    const redirected = join(outside, "scopes", basename(path));
    await writeText(redirected, `${JSON.stringify(ledger)}\n`);

    await expect(loadScopeLedger(userCanonical, scopeIdentity)).rejects.toMatchObject({ code: "permission-denied" });
    await expect(saveScopeLedger(userCanonical, ledger)).rejects.toMatchObject({ code: "permission-denied" });
    expect(await readFile(redirected, "utf8")).toBe(`${JSON.stringify(ledger)}\n`);
  });

  it("rejects a symlink in place of the ledger file", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const userCanonical = join(root, ".agents");
    const scope = join(root, "project");
    await mkdir(join(userCanonical, ".git"), { recursive: true });
    await mkdir(scope);
    const scopeIdentity = await physicalScopeIdentity(scope);
    const ledger = emptyScopeLedger(scopeIdentity);
    const path = ledgerPath(userCanonical, scopeIdentity);
    const outsideFile = join(outside, "ledger.json");
    await writeText(outsideFile, `${JSON.stringify(ledger)}\n`);
    await mkdir(dirname(path), { recursive: true });
    await symlink(outsideFile, path);

    await expect(loadScopeLedger(userCanonical, scopeIdentity)).rejects.toMatchObject({ code: "permission-denied", path });
    await expect(saveScopeLedger(userCanonical, ledger)).rejects.toMatchObject({ code: "permission-denied", path });
    expect(await readFile(outsideFile, "utf8")).toBe(`${JSON.stringify(ledger)}\n`);
  });

  it("rejects malformed and scope-mismatched ledger files", async () => {
    const root = await temporaryDirectory();
    const userCanonical = join(root, ".agents");
    const scope = join(root, "project");
    await mkdir(scope);
    const scopeIdentity = await physicalScopeIdentity(scope);
    const path = ledgerPath(userCanonical, scopeIdentity);
    await writeText(path, "not JSON\n");

    await expect(loadScopeLedger(userCanonical, scopeIdentity)).rejects.toBeInstanceOf(LedgerFormatError);

    await writeFile(path, `${JSON.stringify({ scopeIdentity: join(root, "other"), entries: {} })}\n`);
    await expect(loadScopeLedger(userCanonical, scopeIdentity)).rejects.toMatchObject({
      code: "ledger-scope-mismatch",
      path,
    });
  });
});

describe("ledger digests", () => {
  it("detects file bytes without treating agent permission bits as content", async () => {
    const root = await temporaryDirectory();
    const file = join(root, "reviewer.md");
    await writeFile(file, "first\n");
    await chmod(file, 0o640);
    const initial = await digestFile(file);

    await writeFile(file, "second\n");
    await chmod(file, 0o640);
    const changedBytes = await digestFile(file);
    await writeFile(file, "first\n");
    await chmod(file, 0o750);
    const changedMode = await digestFile(file);

    expect(initial).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(changedBytes).not.toBe(initial);
    expect(changedMode).toBe(initial);
    await chmod(file, 0o640);
    expect(await digestFile(file)).toBe(initial);
  });

  it("hashes skill files and executable bits while ignoring empty directories and directory modes", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, "verify-build");
    const empty = join(skill, "references/empty");
    await writeText(join(skill, "scripts/check.sh"), "#!/bin/sh\n");
    await writeText(join(skill, "SKILL.md"), "skill\n");
    await mkdir(empty, { recursive: true });
    await chmod(empty, 0o750);
    const initial = await digestSkillTree(skill);

    await chmod(empty, 0o700);
    expect(await digestSkillTree(skill)).toBe(initial);
    await mkdir(join(skill, "another-empty"));
    expect(await digestSkillTree(skill)).toBe(initial);
    await chmod(join(skill, "scripts/check.sh"), 0o755);
    expect(await digestSkillTree(skill)).not.toBe(initial);
    await chmod(join(skill, "scripts/check.sh"), 0o644);
    await writeText(join(skill, "scripts/check.sh"), "#!/bin/sh\nexit 0\n");
    expect(await digestSkillTree(skill)).not.toBe(initial);
  });

  it("ignores operating-system metadata names recursively", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, "verify-build");
    await writeText(join(skill, "SKILL.md"), "skill\n");
    await writeText(join(skill, ".env.example"), "SAFE=true\n");
    await mkdir(join(skill, "references"));
    const initial = await digestSkillTree(skill);

    await writeText(join(skill, ".DS_Store"), "noise\n");
    await writeText(join(skill, "references/Desktop.ini"), "noise\n");
    await writeText(join(skill, "references/Thumbs.db"), "noise\n");
    await writeText(join(skill, "references/ehthumbs.db"), "noise\n");
    await writeText(join(skill, "references/._resource"), "noise\n");
    await writeText(join(skill, "._ignored-directory/contents"), "noise\n");
    expect(await digestSkillTree(skill)).toBe(initial);

    await writeText(join(skill, ".env.example"), "SAFE=false\n");
    expect(await digestSkillTree(skill)).not.toBe(initial);
  });

  it("rejects nested Git metadata from the synchronized skill value", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, "verify-build");
    await writeText(join(skill, "SKILL.md"), "skill\n");
    const metadata = join(skill, ".git");
    await writeText(join(metadata, "config"), "[core]\n\trepositoryformatversion = 0\n");

    await expect(digestSkillTree(skill)).rejects.toMatchObject({
      code: "unsupported-entry",
      path: metadata,
    });
  });

  it("rejects file, root, internal, and ignored-name symlinks", async () => {
    const root = await temporaryDirectory();
    const skill = join(root, "verify-build");
    const source = join(root, "source.md");
    await writeText(join(skill, "SKILL.md"), "skill\n");
    await writeText(source, "source\n");
    const fileLink = join(root, "file-link.md");
    const skillLink = join(root, "skill-link");
    await symlink(source, fileLink);
    await symlink(skill, skillLink);

    await expect(digestFile(fileLink)).rejects.toMatchObject({ code: "unsupported-symlink", path: fileLink });
    await expect(digestSkillTree(skillLink)).rejects.toMatchObject({ code: "unsupported-symlink", path: skillLink });

    const internalLink = join(skill, "current.md");
    await symlink(source, internalLink);
    await expect(digestSkillTree(skill)).rejects.toMatchObject({ code: "unsupported-symlink", path: internalLink });

    await unlink(internalLink);
    const ignoredLink = join(skill, ".DS_Store");
    await symlink(source, ignoredLink);
    await expect(digestSkillTree(skill)).rejects.toMatchObject({ code: "unsupported-symlink", path: ignoredLink });
  });
});
