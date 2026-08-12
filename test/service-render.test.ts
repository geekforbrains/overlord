import { describe, expect, it } from "vitest";

import { renderLaunchdDefinition } from "../src/service-launchd.js";
import { renderSystemdDefinition } from "../src/service-systemd.js";

describe("service definition rendering", () => {
  it("renders a deterministic escaped launchd agent", () => {
    const definition = renderLaunchdDefinition({
      nodePath: "/Applications/Node & Tools/node",
      cliPath: "/Users/test/Overlord <dev>/cli.js",
      home: "/Users/test",
      environment: {
        Z_LAST: "quote\" and apostrophe'",
        A_FIRST: "one & two",
      },
      stdoutPath: "/Users/test/Library/Logs/Overlord/watch.log",
      stderrPath: "/Users/test/Library/Logs/Overlord/watch-error.log",
    });

    expect(definition).toContain("<string>/Applications/Node &amp; Tools/node</string>");
    expect(definition).toContain("<string>/Users/test/Overlord &lt;dev&gt;/cli.js</string>");
    expect(definition).toContain("quote&quot; and apostrophe&apos;");
    expect(definition.indexOf("<key>A_FIRST</key>")).toBeLessThan(definition.indexOf("<key>Z_LAST</key>"));
    expect(definition).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(definition).toContain("<key>ExitTimeOut</key>\n  <integer>60</integer>");
    expect(definition).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(definition.endsWith("\n")).toBe(true);
  });

  it("quotes systemd arguments, environment, and percent specifiers without a shell", () => {
    const definition = renderSystemdDefinition({
      nodePath: "/opt/node versions/100%/node",
      cliPath: "/opt/overlord/${CHANNEL}/a\"b\\cli.js",
      home: "/home/test user",
      environment: {
        Z_LAST: "100%",
        A_FIRST: "quote\" slash\\",
      },
    });

    expect(definition).toContain('ExecStart="/opt/node versions/100%%/node" "/opt/overlord/$${CHANNEL}/a\\"b\\\\cli.js" "watch"');
    expect(definition).toContain('WorkingDirectory="/home/test user"');
    expect(definition).toContain('Environment="A_FIRST=quote\\" slash\\\\"');
    expect(definition).toContain('Environment="Z_LAST=100%%"');
    expect(definition.indexOf("Environment=\"A_FIRST")).toBeLessThan(definition.indexOf("Environment=\"Z_LAST"));
    expect(definition).toContain("Restart=always");
    expect(definition).toContain("WantedBy=default.target");
  });
});
