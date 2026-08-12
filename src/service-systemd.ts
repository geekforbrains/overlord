export const SYSTEMD_SERVICE_ID = "overlord-watch.service";

export interface SystemdDefinitionOptions {
  serviceId?: string;
  nodePath: string;
  cliPath: string;
  home: string;
  environment: Readonly<Record<string, string>>;
  escapeExecDollar?: boolean;
}

function systemdText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
}

function systemdWord(value: string): string {
  return `"${systemdText(value)}"`;
}

function systemdExecWord(value: string, escapeDollar: boolean): string {
  const escaped = systemdText(value);
  return `"${escapeDollar ? escaped.replaceAll("$", () => "$$") : escaped}"`;
}

/** Render a deterministic user systemd unit without invoking a shell. */
export function renderSystemdDefinition(options: SystemdDefinitionOptions): string {
  const environment = Object.entries(options.environment).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  const lines = [
    "[Unit]",
    "Description=Overlord skill and agent synchronization",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[options.nodePath, options.cliPath, "watch"]
      .map((value) => systemdExecWord(value, options.escapeExecDollar !== false)).join(" ")}`,
    `WorkingDirectory=${systemdWord(options.home)}`,
  ];
  for (const [name, value] of environment) {
    lines.push(`Environment=${systemdWord(`${name}=${value}`)}`);
  }
  lines.push(
    "UMask=0077",
    "Restart=always",
    "RestartSec=5",
    "TimeoutStopSec=120",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  );
  return lines.join("\n");
}
