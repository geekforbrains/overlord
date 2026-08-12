export const LAUNCHD_SERVICE_ID = "io.github.geekforbrains.overlord.watch";

export interface LaunchdDefinitionOptions {
  serviceId?: string;
  nodePath: string;
  cliPath: string;
  home: string;
  environment: Readonly<Record<string, string>>;
  stdoutPath: string;
  stderrPath: string;
  exitTimeOutSeconds?: number;
}

function xmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stringEntry(value: string, indentation = "  "): string {
  return `${indentation}<string>${xmlText(value)}</string>`;
}

/** Render a deterministic per-user launchd agent definition. */
export function renderLaunchdDefinition(options: LaunchdDefinitionOptions): string {
  const serviceId = options.serviceId ?? LAUNCHD_SERVICE_ID;
  const environment = Object.entries(options.environment).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    stringEntry(serviceId),
    '  <key>Program</key>',
    stringEntry(options.nodePath),
    '  <key>ProgramArguments</key>',
    '  <array>',
    stringEntry(options.nodePath, "    "),
    stringEntry(options.cliPath, "    "),
    stringEntry("watch", "    "),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
  ];
  for (const [name, value] of environment) {
    lines.push(`    <key>${xmlText(name)}</key>`, stringEntry(value, "    "));
  }
  lines.push(
    '  </dict>',
    '  <key>WorkingDirectory</key>',
    stringEntry(options.home),
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    stringEntry("Background"),
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '  <key>ExitTimeOut</key>',
    `  <integer>${options.exitTimeOutSeconds ?? 60}</integer>`,
    '  <key>Umask</key>',
    '  <integer>63</integer>',
    '  <key>StandardOutPath</key>',
    stringEntry(options.stdoutPath),
    '  <key>StandardErrorPath</key>',
    stringEntry(options.stderrPath),
    '</dict>',
    '</plist>',
    '',
  );
  return lines.join("\n");
}

export function launchdDomain(uid: number): string {
  return `gui/${uid}`;
}

export function launchdServiceTarget(uid: number, serviceId = LAUNCHD_SERVICE_ID): string {
  return `${launchdDomain(uid)}/${serviceId}`;
}
