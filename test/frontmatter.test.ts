import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses YAML metadata and preserves the Markdown body", () => {
    const parsed = parseFrontmatter(`---\nname: demo\ndescription: Demo skill\n---\n\nDo the work.\n`, "SKILL.md");
    expect(parsed.attributes).toEqual({ name: "demo", description: "Demo skill" });
    expect(parsed.body).toBe("Do the work.\n");
  });

  it.each([
    ["no opening delimiter", "name: demo\n", "missing YAML frontmatter"],
    ["no closing delimiter", "---\nname: demo\n", "unterminated YAML frontmatter"],
    ["non-map YAML", "---\n- demo\n---\nbody\n", "frontmatter must be a mapping"],
  ])("rejects %s", (_label, source, message) => {
    expect(() => parseFrontmatter(source, "fixture.md")).toThrow(message);
  });
});
