import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import { loadConfig, renderConfig } from "../src/config.js";
import { cleanupTemporaryDirectories, temporaryDirectory, writeText } from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

describe("fleet configuration", () => {
  it("defaults to no discovery roots when the configuration is missing", async () => {
    const home = await temporaryDirectory();

    await expect(loadConfig(join(home, ".agents"), home)).resolves.toEqual({
      roots: [],
    });
  });

  it("expands home-relative roots and deduplicates normalized paths in stable order", async () => {
    const home = await temporaryDirectory();
    const canonicalRoot = join(home, ".agents");
    const projects = join(home, "Projects");
    const clients = join(home, "Clients");
    await writeText(
      join(canonicalRoot, "overlord", "overlord.yaml"),
      [
        "roots:",
        "  - ~/Projects",
        `  - ${clients}`,
        `  - ${projects}/`,
        `  - ${projects}`,
        `  - ${clients}`,
        "",
      ].join("\n"),
    );

    await expect(loadConfig(canonicalRoot, home)).resolves.toEqual({
      roots: [projects, clients],
    });
  });

  it("rejects relative discovery roots", async () => {
    const home = await temporaryDirectory();
    const canonicalRoot = join(home, ".agents");
    const path = join(canonicalRoot, "overlord", "overlord.yaml");
    await writeText(path, "roots:\n  - Projects\n");

    await expect(loadConfig(canonicalRoot, home)).rejects.toMatchObject({
      code: "config-invalid",
      path,
    });
  });

  it("rejects unknown configuration keys", async () => {
    const home = await temporaryDirectory();
    const canonicalRoot = join(home, ".agents");
    const path = join(canonicalRoot, "overlord", "overlord.yaml");
    await writeText(path, "roots: []\nproject: /tmp/example\n");

    await expect(loadConfig(canonicalRoot, home)).rejects.toMatchObject({
      code: "config-invalid",
      path,
    });
  });

  it("rejects configuration version fields", async () => {
    const home = await temporaryDirectory();
    const canonicalRoot = join(home, ".agents");
    const path = join(canonicalRoot, "overlord", "overlord.yaml");
    await writeText(path, "version: 2\nroots: []\n");

    await expect(loadConfig(canonicalRoot, home)).rejects.toMatchObject({
      code: "config-invalid",
      path,
    });
  });

  it("renders only discovery roots", () => {
    expect(renderConfig({ roots: ["/srv/projects", "/work/clients"] })).toBe(
      "roots:\n  - /srv/projects\n  - /work/clients\n",
    );
  });
});
