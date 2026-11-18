// The code a comment quotes: read for its language, numbered and coloured from
// the host's theme.
import { describe, expect, it } from "vitest";
import { highlightLines, languageOf, styleOf, type CodeTheme } from "../app/rail/highlight";

const text = (lines: { text: string }[][]) => lines.map((line) => line.map((t) => t.text).join("")).join("\n");
const kinds = (lines: { text: string; kind: string | null }[][]) => Object.fromEntries(lines.flat().filter((t) => t.kind).map((t) => [t.text, t.kind]));

describe("the quoted code", () => {
  it("knows a file's language by its name", () => {
    expect(languageOf("services/auth/session.go")).toBe("go");
    expect(languageOf("web/src/TokenBadge.tsx")).toBe("typescript");
    expect(languageOf("lib/BUILD.bazel")).toBe("python");
    expect(languageOf("BUILD")).toBe("python");
    expect(languageOf("Dockerfile")).toBe("dockerfile");
    expect(languageOf("notes.txt")).toBeNull();
    expect(languageOf(".gitignore")).toBeNull();
  });

  it("keeps every character and every line, whatever the language", () => {
    const go = 'func main() {\n\tfmt.Println("a < b && c > d") // it\'s "quoted"\n}';
    expect(text(highlightLines(go, "go"))).toBe(go);
    const tsx = "return <Badge tone={a === 'x' ? \"warn\" : `ok ${n}`}>{label}</Badge>;\n\n";
    expect(text(highlightLines(tsx, "typescript"))).toBe(tsx);
    expect(highlightLines("a\n\nb", null)).toEqual([[{ text: "a", kind: null }], [{ text: "", kind: null }], [{ text: "b", kind: null }]]);
    expect(text(highlightLines("plain <b>text</b> & more", "no-such-language"))).toBe("plain <b>text</b> & more");
  });

  it("names what the tokens are", () => {
    const found = kinds(highlightLines('func main() {\n\treturn nil, 15 // why\n}\nconst s = "x"', "go"));
    expect(found.func).toBe("keyword");
    expect(found.main).toBe("title");
    expect(found.nil).toBe("literal");
    expect(found["15"]).toBe("number");
    expect(found["// why"]).toBe("comment");
    expect(found['"x"']).toBe("string");
  });

  it("paints a token from the host theme's rule for its scope, the most specific one", () => {
    const theme: CodeTheme = {
      tokenColors: [
        { settings: { foreground: "#111111" } },
        { scope: "keyword", settings: { foreground: "#aa0000" } },
        { scope: ["keyword.control", "storage"], settings: { foreground: "#ff0000", fontStyle: "bold" } },
        { scope: "comment, string.quoted.docstring", settings: { foreground: "#888888", fontStyle: "italic" } },
        { scope: "meta.function-call entity.name.function", settings: { foreground: "#0000ff" } },
        { scope: "constant.numeric.float", settings: { foreground: "#00ff00" } },
      ],
    };
    expect(styleOf(theme, "keyword")).toEqual({ color: "#ff0000", fontWeight: 600 });
    expect(styleOf(theme, "comment")).toEqual({ color: "#888888", fontStyle: "italic" });
    expect(styleOf(theme, "title.function.invoke")).toEqual({ color: "#0000ff" });
    // A rule for a narrower scope than the token's does not apply; nothing else names numbers.
    expect(styleOf(theme, "number")).toBeNull();
    expect(styleOf(theme, "unheard-of")).toBeNull();
    expect(styleOf(theme, null)).toBeNull();
    expect(styleOf(null, "keyword")).toBeNull();
  });
});
