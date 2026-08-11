/** Native clients supported by Overlord. */
export type TargetName = "claude" | "codex";

export type ArtifactKind = "skill" | "agent";
export type ScopeType = "user" | "project";
export type DefinitionState = "synced" | "missing" | "unadopted" | "conflict" | "invalid";
export type Severity = "info" | "warning" | "error";

interface ScopeBase {
  /** Absolute root of this independent scope. */
  path: string;
  /** Absolute canonical `.agents` directory for this scope. */
  canonical: string;
}

export interface UserScope extends ScopeBase {
  type: "user";
  discoveryRoot?: never;
}

export interface ProjectScope extends ScopeBase {
  type: "project";
  /** Configured parent boundary that discovered a project scope. */
  discoveryRoot: string;
}

export type Scope = UserScope | ProjectScope;

export interface Diagnostic {
  severity: Severity;
  message: string;
  code?: string;
  path?: string;
  scopePath?: string;
  suggestion?: string;
}

/** Provider-specific fields are preserved without translation. */
export type TargetOverlay = Record<string, unknown>;

/**
 * A canonical skill is identified by its directory; the payload itself is read
 * on demand by the copy and comparison passes rather than retained here.
 */
export interface CanonicalSkill {
  name: string;
  path: string;
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

export interface DefinitionRecord {
  kind: ArtifactKind;
  name: string;
  scope: ScopeType;
  scopePath: string;
  state: DefinitionState;
  canonical: string | null;
  outputs: DefinitionOutput[];
  evidence?: string;
  conflictsWith?: string[];
}

export interface ActionRecord {
  id: string;
  status: "planned" | "completed";
  description: string;
  scope: ScopeType;
  scopePath: string;
  reads?: string[];
  writes?: string[];
  removes?: string[];
  /** Recoverable backup paths created by an executed destructive action. */
  backups?: string[];
}

export interface SummaryRecord {
  total: number;
  byState: Partial<Record<DefinitionState, number>>;
  managed: number;
}

export interface TimingRecord {
  totalMs?: number;
}

export interface OutputError {
  code: "usage" | "config-invalid" | "lock-held" | "permission-denied" | "internal";
  message: string;
  path?: string;
  detail?: string;
}

export interface OutputDocument {
  schemaVersion: 2;
  command: "init" | "status" | "check" | "sync";
  status: "ok" | "attention-required" | "error";
  overlordVersion?: string;
  error?: OutputError;
  scopes?: Scope[];
  definitions?: DefinitionRecord[];
  summary?: SummaryRecord;
  actions?: ActionRecord[];
  diagnostics?: Diagnostic[];
  timing?: TimingRecord;
}

export interface EngineOptions {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface CliIo {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
}
