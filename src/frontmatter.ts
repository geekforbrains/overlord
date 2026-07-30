import { isMap, parseDocument } from "yaml";

export interface ParsedFrontmatter {
  attributes: Record<string, unknown>;
  body: string;
}

function frontmatterError(path: string, message: string, cause?: unknown): Error {
  return cause === undefined
    ? new Error(`${path}: ${message}`)
    : new Error(`${path}: ${message}`, { cause });
}

function lineWithoutTerminator(source: string, start: number, end: number): string {
  const line = source.slice(start, end);
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Parse a Markdown file whose first block is YAML frontmatter.
 *
 * The delimiter scan is deliberately line based. Searching for `\n---\n`
 * directly mishandles CRLF files and delimiters at EOF, while handing the
 * entire Markdown document to a YAML parser can accidentally consume body
 * content. One conventional blank separator after the closing delimiter is
 * removed; the rest of the Markdown body is returned byte-for-byte.
 */
export function parseFrontmatter(source: string, path: string): ParsedFrontmatter {
  const firstNewline = source.indexOf("\n");
  const openingEnd = firstNewline === -1 ? source.length : firstNewline;
  let openingLine = lineWithoutTerminator(source, 0, openingEnd);
  if (openingLine.startsWith("\uFEFF")) openingLine = openingLine.slice(1);

  if (!/^---[\t ]*$/.test(openingLine)) {
    throw frontmatterError(path, "missing YAML frontmatter");
  }

  if (firstNewline === -1) {
    throw frontmatterError(path, "unterminated YAML frontmatter");
  }

  const yamlStart = firstNewline + 1;
  let lineStart = yamlStart;
  let closingStart = -1;
  let bodyStart = -1;

  while (lineStart <= source.length) {
    const nextNewline = source.indexOf("\n", lineStart);
    const lineEnd = nextNewline === -1 ? source.length : nextNewline;
    const line = lineWithoutTerminator(source, lineStart, lineEnd);

    if (/^---[\t ]*$/.test(line)) {
      closingStart = lineStart;
      bodyStart = nextNewline === -1 ? source.length : nextNewline + 1;
      break;
    }

    if (nextNewline === -1) break;
    lineStart = nextNewline + 1;
  }

  if (closingStart === -1) {
    throw frontmatterError(path, "unterminated YAML frontmatter");
  }

  const yamlSource = source.slice(yamlStart, closingStart);
  let document;
  try {
    document = parseDocument(yamlSource, {
      prettyErrors: true,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: "1.2",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw frontmatterError(path, `invalid YAML frontmatter: ${message}`, error);
  }

  if (document.errors.length > 0) {
    const detail = document.errors.map((error) => error.message).join("; ");
    throw frontmatterError(path, `invalid YAML frontmatter: ${detail}`, document.errors[0]);
  }

  if (document.contents === null || !isMap(document.contents)) {
    throw frontmatterError(path, "frontmatter must be a mapping");
  }

  const attributes: unknown = document.toJS({ maxAliasCount: 100 });
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw frontmatterError(path, "frontmatter must be a mapping");
  }

  let body = source.slice(bodyStart);
  const separator = body.match(/^[\t ]*(?:\r?\n)/);
  if (separator !== null) body = body.slice(separator[0].length);

  return { attributes: attributes as Record<string, unknown>, body };
}
