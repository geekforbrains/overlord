/** The two native clients supported by the version 0.1 adapter contract. */
export type TargetName = "claude" | "codex";

export type ArtifactKind = "skill" | "agent";
export type ScopeType = "user" | "project";
export type DefinitionState =
  | "synced"
  | "missing"
  | "unadopted"
  | "conflict"
  | "external"
  | "invalid";
export type Severity = "info" | "warning" | "error";
export type ResolutionSide =
  | "agents"
  | "claude"
  | "codex"
  | "adopt"
  | "external"
  | "delete"
  | "skip";

export interface TargetAvailability {
  available: boolean;
  version: string | null;
}

export interface Availability {
  claude: TargetAvailability;
  codex: TargetAvailability;
}

export interface Scope {
  type: ScopeType;
  /** Absolute root of the selected user or project scope. */
  path: string;
  /** Absolute path to the scope's canonical `.agents` directory. */
  canonical: string;
  resolvedBy: "explicit-flag" | "nearest-ancestor" | "git-worktree-root" | "user-default";
  evidence: string;
}

export interface Diagnostic {
  severity: Severity;
  message: string;
  code?: string;
  path?: string;
  suggestion?: string;
}

/**
 * Overlay values intentionally remain open-ended. Both providers add native
 * settings independently, and the synchronizer must preserve fields it does
 * not yet recognise.
 */
export type TargetOverlay = Record<string, unknown>;

export interface SkillFile {
  relativePath: string;
  path: string;
  mode: number;
  contents: Buffer;
  kind?: "file" | "symlink";
  linkTarget?: string;
}

export interface CanonicalSkill {
  name: string;
  description: string;
  body: string;
  path: string;
  skillFile: string;
  attributes: Record<string, unknown>;
  files: SkillFile[];
  /** Relative directory paths, including empty directories, in lexical order. */
  directories: string[];
  valid: boolean;
}

export interface CanonicalAgent {
  version: 1;
  name: string;
  description: string;
  body: string;
  path: string;
  valid: boolean;
  targets: {
    claude: TargetOverlay | false;
    codex: TargetOverlay | false;
  };
}

export interface CanonicalScope {
  skills: CanonicalSkill[];
  agents: CanonicalAgent[];
  diagnostics: Diagnostic[];
}

export interface DefinitionOutput {
  target: TargetName;
  path: string;
  state: DefinitionState;
  readsCanonicalDirectly?: boolean;
}

export interface DecisionRecord {
  selector: string;
  options: ResolutionSide[];
}

export interface DefinitionRecord {
  kind: ArtifactKind;
  name: string;
  scope: ScopeType;
  state: DefinitionState;
  project?: string;
  canonical?: string | null;
  outputs?: DefinitionOutput[];
  evidence?: string;
  conflictsWith?: string[];
  decision?: DecisionRecord;
  externalReason?: string;
}

export interface ActionRecord {
  id: string;
  description: string;
  argv: string[];
  mutates: boolean;
  requiresConfirmation?: boolean;
  requiresDecision?: boolean;
  scope?: ScopeType;
  reads?: string[];
  writes?: string[];
  removes?: string[];
  /** Recoverable backup paths created by an executed destructive action. */
  backups?: string[];
}

export interface TargetRecord extends TargetAvailability {
  name: TargetName;
  paths?: Record<string, string>;
  observability?: string[];
}

export interface SummaryRecord {
  total?: number;
  byState?: Partial<Record<DefinitionState, number>>;
  managed?: number;
  adoptionComplete?: boolean;
}

export interface TimingRecord {
  totalMs?: number;
  scanMs?: number;
  compareMs?: number;
  renderMs?: number;
}

export interface OutputError {
  code:
    | "usage"
    | "config-invalid"
    | "scope-unresolvable"
    | "lock-held"
    | "permission-denied"
    | "internal";
  message: string;
  path?: string;
  detail?: string;
}

export interface OutputDocument {
  schemaVersion: 1;
  command: "init" | "status" | "check" | "sync";
  status: "ok" | "attention-required" | "error";
  overlordVersion?: string;
  dryRun?: boolean;
  error?: OutputError;
  scope?: Scope;
  targets?: TargetRecord[];
  definitions?: DefinitionRecord[];
  summary?: SummaryRecord;
  actions?: ActionRecord[];
  diagnostics?: Diagnostic[];
  timing?: TimingRecord;
}

export interface EngineOptions {
  cwd: string;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  global?: boolean;
  project?: string | undefined;
  strict?: boolean;
  availability?: Availability;
}

export interface InitializeOptions {
  dryRun: boolean;
}

export interface SyncOptions {
  dryRun: boolean;
  resolutions: Readonly<Record<string, ResolutionSide>>;
  confirmDestructive?: boolean;
}

export interface CliIo {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  isTTY: boolean;
}
