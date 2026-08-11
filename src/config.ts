import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "yaml";

export interface OverlordConfig {
  version: 2;
  roots: string[];
}

class ConfigError extends Error {
  readonly code = "config-invalid" as const;
  constructor(message: string, readonly path: string, readonly detail?: string) {
    super(message);
    this.name = "ConfigError";
  }
}

let validateConfig: ValidateFunction | undefined;

async function validator(): Promise<ValidateFunction> {
  if (validateConfig !== undefined) return validateConfig;
  const schemaUrl = new URL("../docs/schemas/config.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  validateConfig = ajv.compile(schema);
  return validateConfig;
}

export function configPath(canonicalRoot: string): string {
  return join(canonicalRoot, "overlord", "overlord.yaml");
}

export async function loadConfig(canonicalRoot: string, home: string): Promise<OverlordConfig> {
  const path = configPath(canonicalRoot);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, roots: [] };
    throw new ConfigError("Configuration cannot be read", path, error instanceof Error ? error.message : String(error));
  }

  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    throw new ConfigError("Configuration contains invalid YAML", path, error instanceof Error ? error.message : String(error));
  }

  const validate = await validator();
  if (!validate(parsed)) {
    const first = validate.errors?.[0];
    const missingProperty = first?.params && "missingProperty" in first.params
      ? String((first.params as { missingProperty?: string }).missingProperty ?? "")
      : "";
    const additionalProperty = first?.params && "additionalProperty" in first.params
      ? String((first.params as { additionalProperty?: string }).additionalProperty ?? "")
      : "";
    const keyPath = missingProperty.length > 0
      ? `${first?.instancePath ?? ""}/${missingProperty}`
      : additionalProperty.length > 0
        ? `${first?.instancePath ?? ""}/${additionalProperty}`
      : first?.instancePath ?? "";
    throw new ConfigError(
      `Configuration is invalid at ${keyPath || "/"}`,
      path,
      validate.errors?.map((entry) => `${entry.instancePath || "/"} ${entry.message ?? "is invalid"}`).join("; "),
    );
  }

  const config = parsed as { version: 2; roots?: string[] };
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const [index, configuredRoot] of (config.roots ?? []).entries()) {
    const homeRelative = configuredRoot.startsWith("~/");
    if (!homeRelative && !isAbsolute(configuredRoot)) {
      throw new ConfigError(
        `Configuration is invalid at /roots/${index}`,
        path,
        "Discovery roots must be absolute paths or start with '~/'.",
      );
    }
    const normalizedRoot = resolve(homeRelative ? join(home, configuredRoot.slice(2)) : configuredRoot);
    if (seen.has(normalizedRoot)) continue;
    seen.add(normalizedRoot);
    roots.push(normalizedRoot);
  }
  return { version: 2, roots };
}

export function renderConfig(config: OverlordConfig): string {
  const ordered: Record<string, unknown> = { version: 2, roots: config.roots };
  return stringify(ordered, { lineWidth: 0, indent: 2 });
}
