import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { IGNORED_SKILL_FILES, assertNoSymlinkedParent, reservedSkillArtifact } from "./filesystem.js";
import type { ArtifactKind } from "./types.js";

export type LedgerEndpoint = "canonical" | "claude" | "codex";

export interface LedgerReceipt {
  /** Absolute endpoint path at the time this receipt was recorded. */
  path: string;
  digest: string;
}

export interface LedgerReceipts {
  canonical?: LedgerReceipt;
  claude?: LedgerReceipt;
  codex?: LedgerReceipt;
}

export interface LedgerEntry {
  receipts: LedgerReceipts;
  /** Last synchronized canonical agent source, retained for future lossless merges. */
  canonicalSource?: string;
}

export interface LedgerKey {
  /** A pinned real path, not a user-visible path alias. */
  scopeIdentity: string;
  kind: ArtifactKind;
  name: string;
}

export interface ScopeLedger {
  scopeIdentity: string;
  entries: Record<ArtifactKind, Record<string, LedgerEntry>>;
}

export type LedgerFormatErrorCode = "invalid-ledger" | "ledger-scope-mismatch";

export class LedgerFormatError extends Error {
  readonly code: LedgerFormatErrorCode;
  readonly path: string;

  constructor(code: LedgerFormatErrorCode, message: string, path: string) {
    super(message);
    this.name = "LedgerFormatError";
    this.code = code;
    this.path = path;
  }
}

const ENDPOINTS: readonly LedgerEndpoint[] = ["canonical", "claude", "codex"];
const KINDS: readonly ArtifactKind[] = ["agent", "skill"];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidLedger(path: string, detail: string): LedgerFormatError {
  return new LedgerFormatError("invalid-ledger", `Invalid synchronization ledger at ${path}: ${detail}`, path);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) throw invalidLedger(path, `${label} contains unknown field '${unexpected}'`);
}

function validateScopeIdentity(scopeIdentity: string): void {
  if (scopeIdentity.length === 0 || !isAbsolute(scopeIdentity) || resolve(scopeIdentity) !== scopeIdentity) {
    throw new TypeError(`Ledger scope identity must be an absolute normalized path: ${scopeIdentity}`);
  }
}

/** Resolve a logical scope path to the physical identity used by ledger keys. */
export async function physicalScopeIdentity(scopePath: string): Promise<string> {
  const physicalPath = await realpath(resolve(scopePath));
  const metadata = await lstat(physicalPath);
  if (!metadata.isDirectory()) throw new TypeError(`Ledger scope must be a directory: ${scopePath}`);
  return physicalPath;
}

/** Return the machine-local receipt path for one physical scope. */
export function ledgerPath(userCanonicalRoot: string, scopeIdentity: string): string {
  validateScopeIdentity(scopeIdentity);
  const identityDigest = createHash("sha256").update(scopeIdentity).digest("hex");
  return join(userCanonicalRoot, ".git", "overlord", "scopes", `${identityDigest}.json`);
}

export function emptyScopeLedger(scopeIdentity: string): ScopeLedger {
  validateScopeIdentity(scopeIdentity);
  return { scopeIdentity, entries: { agent: {}, skill: {} } };
}

async function assertLedgerMetadataParents(
  userCanonicalRoot: string,
  path: string,
  requireRepository: boolean,
): Promise<void> {
  const metadataRoot = join(userCanonicalRoot, ".git");
  let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    metadata = await lstat(metadataRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (metadata === undefined) {
    if (!requireRepository) return;
    throw Object.assign(new Error(`Ledger metadata requires a physical Git directory: ${metadataRoot}`), {
      code: "permission-denied",
      path: metadataRoot,
    });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw Object.assign(new Error(`Ledger metadata requires a physical Git directory: ${metadataRoot}`), {
      code: "permission-denied",
      path: metadataRoot,
    });
  }
  await assertNoSymlinkedParent(path, metadataRoot);
}

async function physicalLedgerFileExists(path: string): Promise<boolean> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw Object.assign(new Error(`Ledger must be a physical file: ${path}`), {
      code: "permission-denied",
      path,
    });
  }
  return true;
}

function normalizeReceipts(value: unknown, path: string): LedgerReceipts {
  if (!isRecord(value)) throw invalidLedger(path, "entry receipts must be an object");
  assertOnlyKeys(value, new Set(ENDPOINTS), path, "entry receipts");
  const receipts: LedgerReceipts = {};
  for (const endpoint of ENDPOINTS) {
    if (!hasOwn(value, endpoint)) continue;
    const receipt = value[endpoint];
    if (!isRecord(receipt)) throw invalidLedger(path, `receipt '${endpoint}' must be an object`);
    assertOnlyKeys(receipt, new Set(["path", "digest"]), path, `receipt '${endpoint}'`);
    if (typeof receipt.path !== "string"
      || !isAbsolute(receipt.path)
      || resolve(receipt.path) !== receipt.path) {
      throw invalidLedger(path, `receipt '${endpoint}' path must be absolute and normalized`);
    }
    if (typeof receipt.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(receipt.digest)) {
      throw invalidLedger(path, `receipt '${endpoint}' digest must be a SHA-256 digest string`);
    }
    receipts[endpoint] = { path: receipt.path, digest: receipt.digest };
  }
  return receipts;
}

function normalizeEntry(value: unknown, path: string): LedgerEntry {
  if (!isRecord(value)) throw invalidLedger(path, "definition entry must be an object");
  assertOnlyKeys(value, new Set(["receipts", "canonicalSource"]), path, "definition entry");
  const receipts = normalizeReceipts(value.receipts, path);
  if (!hasOwn(value, "canonicalSource")) return { receipts };
  if (typeof value.canonicalSource !== "string") {
    throw invalidLedger(path, "entry canonicalSource must be a string when present");
  }
  return { receipts, canonicalSource: value.canonicalSource };
}

function normalizeLedger(value: unknown, expectedScopeIdentity: string, path: string): ScopeLedger {
  if (!isRecord(value)) throw invalidLedger(path, "top-level value must be an object");
  assertOnlyKeys(value, new Set(["scopeIdentity", "entries"]), path, "top-level object");
  if (typeof value.scopeIdentity !== "string") throw invalidLedger(path, "scopeIdentity must be a string");
  if (value.scopeIdentity !== expectedScopeIdentity) {
    throw new LedgerFormatError(
      "ledger-scope-mismatch",
      `Synchronization ledger at ${path} belongs to '${value.scopeIdentity}', not '${expectedScopeIdentity}'.`,
      path,
    );
  }
  if (!isRecord(value.entries)) throw invalidLedger(path, "entries must be an object");
  assertOnlyKeys(value.entries, new Set(KINDS), path, "entries");

  const normalized = emptyScopeLedger(expectedScopeIdentity);
  for (const kind of KINDS) {
    const rawDefinitions = value.entries[kind];
    if (rawDefinitions === undefined) continue;
    if (!isRecord(rawDefinitions)) throw invalidLedger(path, `entries.${kind} must be an object`);
    for (const name of Object.keys(rawDefinitions).sort(compareText)) {
      if (name.length === 0) throw invalidLedger(path, `entries.${kind} contains an empty definition name`);
      normalized.entries[kind][name] = normalizeEntry(rawDefinitions[name], path);
    }
  }
  return normalized;
}

/** Read one scope's receipts. A missing file is an empty ledger and causes no writes. */
export async function loadScopeLedger(userCanonicalRoot: string, scopeIdentity: string): Promise<ScopeLedger> {
  const path = ledgerPath(userCanonicalRoot, scopeIdentity);
  await assertLedgerMetadataParents(userCanonicalRoot, path, false);
  if (!(await physicalLedgerFileExists(path))) return emptyScopeLedger(scopeIdentity);
  const source = await readFile(path, "utf8");

  let document: unknown;
  try {
    document = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw invalidLedger(path, `cannot parse JSON (${detail})`);
  }
  return normalizeLedger(document, scopeIdentity, path);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareText)) sorted[key] = sortJson(value[key]);
  return sorted;
}

/** Replace one scope's ledger through a same-directory temporary file and rename. */
export async function saveScopeLedger(userCanonicalRoot: string, ledger: ScopeLedger): Promise<void> {
  const path = ledgerPath(userCanonicalRoot, ledger.scopeIdentity);
  await assertLedgerMetadataParents(userCanonicalRoot, path, true);
  await physicalLedgerFileExists(path);
  const normalized = normalizeLedger(ledger, ledger.scopeIdentity, path);
  const source = `${JSON.stringify(sortJson(normalized), null, 2)}\n`;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw Object.assign(new Error(`Ledger directory must be a physical directory: ${directory}`), {
      code: "unsupported-symlink",
      path: directory,
    });
  }
  await chmod(directory, 0o700);

  const temporaryPath = join(directory, `.overlord-ledger-${randomUUID()}.tmp`);
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(source, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function assertMatchingScope(ledger: ScopeLedger, key: LedgerKey): void {
  if (ledger.scopeIdentity !== key.scopeIdentity) {
    throw new TypeError(
      `Ledger key scope identity '${key.scopeIdentity}' does not match ledger scope identity '${ledger.scopeIdentity}'.`,
    );
  }
}

export function getLedgerEntry(ledger: ScopeLedger, key: LedgerKey): LedgerEntry | undefined {
  assertMatchingScope(ledger, key);
  return ledger.entries[key.kind][key.name];
}

export function setLedgerEntry(ledger: ScopeLedger, key: LedgerKey, entry: LedgerEntry): void {
  assertMatchingScope(ledger, key);
  if (key.name.length === 0) throw new TypeError("Ledger definition name must not be empty.");
  ledger.entries[key.kind][key.name] = normalizeEntry(entry, "<memory>");
}

export function deleteLedgerEntry(ledger: ScopeLedger, key: LedgerKey): boolean {
  assertMatchingScope(ledger, key);
  const definitions = ledger.entries[key.kind];
  const existed = hasOwn(definitions, key.name);
  delete definitions[key.name];
  return existed;
}

function ignoredSkillArtifact(name: string): boolean {
  return IGNORED_SKILL_FILES.has(name) || name.startsWith("._");
}

function unsupportedSymlink(path: string): Error {
  return Object.assign(new Error(`Cannot digest symlink '${path}'; symlinks are not supported.`), {
    code: "unsupported-symlink",
    path,
  });
}

function unsupportedEntry(path: string): Error {
  return Object.assign(new Error(`Cannot digest unsupported filesystem entry '${path}'.`), {
    code: "unsupported-entry",
    path,
  });
}

function addHashField(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function digestResult(hash: ReturnType<typeof createHash>): string {
  return `sha256:${hash.digest("hex")}`;
}

/** Hash one agent file using its raw bytes. */
export async function digestFile(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw unsupportedSymlink(path);
  if (!metadata.isFile()) throw unsupportedEntry(path);
  const hash = createHash("sha256");
  addHashField(hash, "overlord-agent-file");
  addHashField(hash, await readFile(path));
  return digestResult(hash);
}

interface TreeDigestEntry {
  relativePath: string;
  executable: boolean;
  contents: Buffer;
}

async function collectTreeEntries(root: string, current: string, entries: TreeDigestEntry[]): Promise<void> {
  const children = await readdir(current, { withFileTypes: true });
  children.sort((left, right) => compareText(left.name, right.name));
  for (const child of children) {
    const path = join(current, child.name);
    if (child.isSymbolicLink()) throw unsupportedSymlink(path);
    if (ignoredSkillArtifact(child.name)) continue;
    if (reservedSkillArtifact(child.name)) throw unsupportedEntry(path);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw unsupportedSymlink(path);
    const relativePath = relative(root, path).split(sep).join("/");
    if (metadata.isDirectory()) {
      await collectTreeEntries(root, path, entries);
    } else if (metadata.isFile()) {
      entries.push({
        relativePath,
        executable: (metadata.mode & 0o111) !== 0,
        contents: await readFile(path),
      });
    } else {
      throw unsupportedEntry(path);
    }
  }
}

/** Hash the Git-representable skill value: sorted file paths, executable bits, and bytes. */
export async function digestSkillTree(root: string): Promise<string> {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink()) throw unsupportedSymlink(root);
  if (!rootMetadata.isDirectory()) throw unsupportedEntry(root);
  const entries: TreeDigestEntry[] = [];
  await collectTreeEntries(root, root, entries);

  const hash = createHash("sha256");
  addHashField(hash, "overlord-skill-files");
  for (const entry of entries) {
    addHashField(hash, entry.relativePath);
    addHashField(hash, entry.executable ? "executable" : "regular");
    addHashField(hash, entry.contents);
  }
  return digestResult(hash);
}
