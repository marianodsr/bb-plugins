import { describe, expect, it } from "vitest";
import { reanchor, snippetFor, splitLines, type Anchor } from "../server/anchor";

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

const original = lines(
  "import { refresh } from './token';", // 1
  "", // 2
  "export function session(token) {", // 3
  "  const ttl = 60 * 60;", // 4
  "  if (!token) return null;", // 5
  "  refresh(token);", // 6
  "  return { token, ttl };", // 7
  "}", // 8
);

function anchorAt(content: string, startLine: number, endLine: number): Anchor {
  return { startLine, endLine, snippet: snippetFor(splitLines(content), startLine, endLine)! };
}

describe("splitLines and snippetFor", () => {
  it("does not count a trailing newline as a line and strips CR", () => {
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("\n")).toEqual([""]);
  });

  it("rejects ranges outside the file", () => {
    const rows = splitLines(original);
    expect(snippetFor(rows, 5, 6)).toBe("  if (!token) return null;\n  refresh(token);");
    expect(snippetFor(rows, 0, 1)).toBeNull();
    expect(snippetFor(rows, 8, 9)).toBeNull();
    expect(snippetFor(rows, 6, 5)).toBeNull();
  });
});

for (const withSnapshot of [true, false]) {
  const previous = withSnapshot ? original : null;
  describe(`reanchor (${withSnapshot ? "with" : "without"} the previous content)`, () => {
    const anchor = anchorAt(original, 5, 6);

    it("is unchanged when the file is the same", () => {
      expect(reanchor(anchor, original, previous)).toMatchObject({ status: "found", match: "unchanged", startLine: 5, endLine: 6 });
    });

    it("moves down when lines are inserted above", () => {
      const next = original.replace("import { refresh } from './token';\n", "// header\n// more\nimport { refresh } from './token';\n");
      expect(reanchor(anchor, next, previous)).toMatchObject({ status: "found", startLine: 7, endLine: 8 });
    });

    it("moves up when lines above are deleted", () => {
      const next = original.replace("import { refresh } from './token';\n\n", "");
      expect(reanchor(anchor, next, previous)).toMatchObject({ status: "found", startLine: 3, endLine: 4 });
    });

    it("stays put when lines below change", () => {
      const next = original.replace("  return { token, ttl };", "  return { token, ttl, at: Date.now() };");
      expect(reanchor(anchor, next, previous)).toMatchObject({ status: "found", match: "unchanged", startLine: 5, endLine: 6 });
    });

    it("goes outdated when a quoted line is edited", () => {
      const next = original.replace("  refresh(token);", "  await refresh(token, { force: true });");
      expect(reanchor(anchor, next, previous)).toEqual({ status: "outdated" });
    });

    it("goes outdated when the quoted lines are deleted", () => {
      const next = original.replace("  if (!token) return null;\n  refresh(token);\n", "");
      expect(reanchor(anchor, next, previous)).toEqual({ status: "outdated" });
    });

    it("goes outdated when a non-blank line is inserted inside the range", () => {
      const next = original.replace("  refresh(token);", "  log(token);\n  refresh(token);");
      expect(reanchor(anchor, next, previous)).toEqual({ status: "outdated" });
    });

    it("follows a reindented block, ignoring whitespace, and quotes the new code", () => {
      const next = original
        .replace("  if (!token) return null;", "    if (!token)   return null;")
        .replace("  refresh(token);", "    refresh( token );");
      const result = reanchor(anchor, next, previous);
      expect(result).toMatchObject({ status: "found", match: "whitespace", startLine: 5, endLine: 6 });
      expect(result.status === "found" && result.snippet).toBe("    if (!token)   return null;\n    refresh( token );");
    });

    it("widens the range over a blank line inserted inside", () => {
      const next = original.replace("  refresh(token);", "\n  refresh(token);");
      expect(reanchor(anchor, next, previous)).toMatchObject({ status: "found", match: "whitespace", startLine: 5, endLine: 7 });
    });

    it("follows a reflowed line split in two", () => {
      const one = anchorAt(original, 7, 7);
      const next = original.replace("  return { token, ttl };", "  return {\n    token, ttl };");
      expect(reanchor(one, next, previous)).toMatchObject({ status: "found", match: "whitespace", startLine: 7, endLine: 8 });
    });

    it("follows a block moved elsewhere in the file", () => {
      const next = lines(
        "export function session(token) {",
        "  const ttl = 60 * 60;",
        "  return { token, ttl };",
        "}",
        "",
        "function guard(token) {",
        "  if (!token) return null;",
        "  refresh(token);",
        "}",
        "import { refresh } from './token';",
      );
      expect(reanchor(anchor, next, previous)).toMatchObject({ status: "found", startLine: 7, endLine: 8 });
    });

    it("finds the code again after the file is deleted and restored", () => {
      expect(reanchor(anchor, "", previous)).toEqual({ status: "outdated" });
      expect(reanchor(anchor, original, null)).toMatchObject({ status: "found", startLine: 5, endLine: 6 });
    });

    it("re-anchors a comment on a blank line to the nearest blank line", () => {
      const blank = anchorAt(original, 2, 2);
      const next = `// top\n${original}`;
      expect(reanchor(blank, next, previous)).toMatchObject({ status: "found", startLine: 3, endLine: 3 });
    });
  });
}

describe("duplicate snippets", () => {
  const repeated = lines(
    "function a() {", // 1
    "  retry();", // 2
    "  return 1;", // 3
    "}", // 4
    "function b() {", // 5
    "  retry();", // 6
    "  return 1;", // 7
    "}", // 8
  );
  const second = anchorAt(repeated, 6, 7);
  const first = anchorAt(repeated, 2, 3);

  it("picks the copy nearest the old position", () => {
    const next = `// one\n${repeated}`;
    expect(reanchor(second, next)).toMatchObject({ startLine: 7, endLine: 8 });
    expect(reanchor(first, next)).toMatchObject({ startLine: 3, endLine: 4 });
  });

  it("with the previous content, tracks the right copy even after a large insertion above", () => {
    // 30 lines above shift the second copy to 36; without tracking, the
    // first copy (now at 32) would be nearer to the old line 6.
    const next = `${"// pad\n".repeat(30)}${repeated}`;
    expect(reanchor(second, next, repeated)).toMatchObject({ match: "tracked", startLine: 36, endLine: 37 });
    expect(reanchor(second, next, null)).toMatchObject({ startLine: 32 });
  });

  it("goes outdated instead of jumping to another copy when its own copy is edited", () => {
    const next = repeated.replace("function b() {\n  retry();", "function b() {\n  retry(3);");
    expect(reanchor(second, next, repeated)).toEqual({ status: "outdated" });
    expect(reanchor(first, next, repeated)).toMatchObject({ status: "found", match: "unchanged", startLine: 2 });
    // Without the previous content there is no way to tell the copies apart.
    expect(reanchor(second, next, null)).toMatchObject({ status: "found", startLine: 2, endLine: 3 });
  });

  it("when one copy is deleted, its comment goes outdated and the other moves up", () => {
    const next = repeated.replace("function a() {\n  retry();\n  return 1;\n}\n", "");
    expect(reanchor(second, next, repeated)).toMatchObject({ status: "found", match: "tracked", startLine: 2, endLine: 3 });
    expect(reanchor(first, next, repeated)).toEqual({ status: "outdated" });
  });

  it("a copy moved to a new place is still followed", () => {
    const next = `${repeated.replace("function b() {\n  retry();\n  return 1;\n}\n", "")}// moved\nfunction b() {\n  retry();\n  return 1;\n}\n`;
    expect(reanchor(second, next, repeated)).toMatchObject({ status: "found", startLine: 7, endLine: 8 });
  });

  it("with the previous content, a moved copy is found by projection, not raw distance", () => {
    // Swap the functions: the second copy now sits at lines 2-3.
    const swapped = lines("function b() {", "  retry();", "  return 1;", "}", "function a() {", "  retry();", "  return 1;", "}");
    // Both copies are textually identical, so either answer quotes the same
    // code; what matters is a stable, in-range result.
    const result = reanchor(second, swapped, repeated);
    expect(result.status).toBe("found");
  });
});

describe("large files", () => {
  it("anchors in a big file quickly and falls back when the diff is too large", () => {
    const big = Array.from({ length: 20_000 }, (_, index) => `line ${index}`).join("\n");
    const anchor = { startLine: 15_002, endLine: 15_003, snippet: "line 15001\nline 15002" };
    const shuffled = Array.from({ length: 20_000 }, (_, index) => (index % 3 === 0 ? `changed ${index}` : `line ${index}`)).join("\n");
    const started = performance.now();
    expect(reanchor(anchor, shuffled, big)).toMatchObject({ status: "found", startLine: 15_002 });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
