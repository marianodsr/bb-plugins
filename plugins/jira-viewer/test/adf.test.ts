import { describe, expect, it } from "vitest";
import { richDescription } from "../mock/fixtures.ts";
import { adfToMarkdown, adfToPlainText, escapeText } from "../src/adf.js";

const t = (text: string, marks?: unknown[]) => (marks ? { type: "text", text, marks } : { type: "text", text });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });

describe("adfToMarkdown", () => {
  it("returns empty for null, undefined and garbage", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown(undefined)).toBe("");
    expect(adfToMarkdown(42)).toBe("");
    expect(adfToMarkdown({})).toBe("");
    expect(adfToMarkdown({ type: "doc", content: "nope" })).toBe("");
    expect(adfToMarkdown(doc(null, 3, "x"))).toBe("x");
  });

  it("treats a plain string as text", () => {
    expect(adfToMarkdown("hello *world*")).toBe("hello \\*world\\*");
  });

  it("renders headings, clamping odd levels", () => {
    expect(adfToMarkdown(doc({ type: "heading", attrs: { level: 2 }, content: [t("Title")] }))).toBe("## Title");
    expect(adfToMarkdown(doc({ type: "heading", attrs: { level: 9 }, content: [t("Deep")] }))).toBe("###### Deep");
    expect(adfToMarkdown(doc({ type: "heading", attrs: {}, content: [t("None")] }))).toBe("## None");
  });

  it("applies marks and merges adjacent runs", () => {
    const md = adfToMarkdown(
      doc(
        p(
          t("a", [{ type: "strong" }]),
          t("b", [{ type: "strong" }]),
          t(" plain "),
          t("em", [{ type: "em" }]),
          t(" "),
          t("gone", [{ type: "strike" }]),
          t(" "),
          t("x`y", [{ type: "code" }]),
        ),
      ),
    );
    expect(md).toBe("**ab** plain *em* ~~gone~~ ``x`y``");
  });

  it("hoists whitespace out of emphasis", () => {
    expect(adfToMarkdown(doc(p(t("say"), t(" bold ", [{ type: "strong" }]), t("now"))))).toBe("say **bold** now");
  });

  it("renders links and refuses unsafe schemes", () => {
    expect(
      adfToMarkdown(doc(p(t("site", [{ type: "link", attrs: { href: "https://example.com/a b" } }])))),
    ).toBe("[site](<https://example.com/a b>)");
    expect(
      adfToMarkdown(doc(p(t("bad", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])))),
    ).toBe("bad");
    expect(
      adfToMarkdown(doc(p(t("bold link", [{ type: "strong" }, { type: "link", attrs: { href: "https://x.test" } }])))),
    ).toBe("[**bold link**](https://x.test)");
  });

  it("renders nested lists with correct indentation", () => {
    const md = adfToMarkdown(
      doc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              p(t("one")),
              {
                type: "orderedList",
                attrs: { order: 3 },
                content: [
                  { type: "listItem", content: [p(t("three"))] },
                  {
                    type: "listItem",
                    content: [p(t("four")), { type: "bulletList", content: [{ type: "listItem", content: [p(t("deep"))] }] }],
                  },
                ],
              },
            ],
          },
          { type: "listItem", content: [p(t("two"))] },
        ],
      }),
    );
    expect(md).toBe(["- one", "  3. three", "  4. four", "     - deep", "- two"].join("\n"));
  });

  it("keeps multi-paragraph list items loose and code blocks inside items", () => {
    const md = adfToMarkdown(
      doc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [p(t("first")), p(t("second")), { type: "codeBlock", attrs: { language: "sh" }, content: [t("ls\npwd")] }],
          },
        ],
      }),
    );
    expect(md).toBe(["- first", "", "  second", "", "  ```sh", "  ls", "  pwd", "  ```"].join("\n"));
  });

  it("renders task lists, including a nested task list", () => {
    const md = adfToMarkdown(
      doc({
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { state: "DONE" }, content: [t("done")] },
          { type: "taskItem", attrs: { state: "TODO" }, content: [t("todo")] },
          { type: "taskList", content: [{ type: "taskItem", attrs: { state: "TODO" }, content: [t("child")] }] },
        ],
      }),
    );
    expect(md).toBe(["- [x] done", "- [ ] todo", "      - [ ] child"].join("\n"));
  });

  it("fences code containing backticks with a longer fence", () => {
    const md = adfToMarkdown(doc({ type: "codeBlock", attrs: { language: "md; rm -rf" }, content: [t("```\ninner\n```")] }));
    expect(md).toBe("````mdrm-rf\n```\ninner\n```\n````");
  });

  it("renders tables with header, escaped pipes, colspans and ragged rows", () => {
    const md = adfToMarkdown(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [p(t("A"))] },
              { type: "tableHeader", content: [p(t("B"))] },
              { type: "tableHeader", content: [p(t("C"))] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", attrs: { colspan: 2 }, content: [p(t("wide | cell"))] },
              {
                type: "tableCell",
                content: [{ type: "bulletList", content: [{ type: "listItem", content: [p(t("x"))] }, { type: "listItem", content: [p(t("y"))] }] }],
              },
            ],
          },
          { type: "tableRow", content: [{ type: "tableCell", content: [p(t("short"))] }] },
        ],
      }),
    );
    expect(md).toBe(["| A | B | C |", "| --- | --- | --- |", "| wide \\| cell |   | • x • y |", "| short |   |   |"].join("\n"));
  });

  it("flattens a table nested in a table cell rather than breaking the grid", () => {
    const inner = { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p(t("inner"))] }] }] };
    const md = adfToMarkdown(doc({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [inner] }] }] }));
    expect(md).toBe("| inner |\n| --- |");
  });

  it("renders panels as labelled quotes and expands with titles", () => {
    expect(adfToMarkdown(doc({ type: "panel", attrs: { panelType: "error" }, content: [p(t("Broken"))] }))).toBe(
      "> **Error**\n>\n> Broken",
    );
    expect(adfToMarkdown(doc({ type: "expand", attrs: { title: "More" }, content: [p(t("hidden"))] }))).toBe("**More**\n\nhidden");
  });

  it("renders mentions, emoji, dates, status, cards and media placeholders", () => {
    const md = adfToMarkdown(
      doc(
        p(
          { type: "mention", attrs: { id: "1", text: "@Ana Ruiz" } },
          t(" "),
          { type: "mention", attrs: { id: "2" } },
          t(" "),
          { type: "emoji", attrs: { shortName: ":smile:", text: "😄" } },
          t(" "),
          { type: "date", attrs: { timestamp: "1762300800000" } },
          t(" "),
          { type: "status", attrs: { text: "IN REVIEW" } },
          t(" "),
          { type: "inlineCard", attrs: { url: "https://x.test/browse/ENG-1" } },
          t(" "),
          { type: "mediaInline", attrs: { id: "m", alt: "spec.pdf" } },
        ),
        { type: "mediaGroup", content: [{ type: "media", attrs: { id: "a", type: "file" } }, { type: "media", attrs: { id: "b", type: "external", url: "https://img.test/x.png", alt: "shot" } }] },
        { type: "blockCard", attrs: { url: "https://x.test/page", data: { name: "Design doc" } } },
      ),
    );
    expect(md).toBe(
      [
        "@Ana Ruiz @someone 😄 2025-11-05 `IN REVIEW` [ENG-1](https://x.test/browse/ENG-1) *Attachment: spec.pdf*",
        "",
        "*Attachment*\n[Image: shot](https://img.test/x.png)",
        "",
        "[Design doc](https://x.test/page)",
      ].join("\n"),
    );
  });

  it("degrades unknown nodes to their text, never to nothing", () => {
    expect(adfToMarkdown(doc({ type: "futureBlock", content: [p(t("inside"))] }))).toBe("inside");
    expect(adfToMarkdown(doc(p({ type: "futureInline", content: [t("inline text")] })))).toBe("inline text");
    expect(adfToMarkdown(doc({ type: "futureLeaf", attrs: { text: "attr text" } }))).toBe("attr text");
    expect(adfToMarkdown(doc({ type: "futureLeaf", text: "own text" }))).toBe("own text");
    expect(adfToMarkdown(doc({ type: "extension", attrs: { extensionKey: "jira-chart" } }))).toBe("*Jira macro: jira-chart*");
    expect(adfToMarkdown(doc({ type: "bodiedExtension", content: [p(t("body"))] }))).toBe("body");
  });

  it("renders hard breaks without a trailing backslash", () => {
    expect(adfToMarkdown(doc(p(t("a"), { type: "hardBreak" }, t("b"), { type: "hardBreak" })))).toBe("a\\\nb");
  });

  it("escapes markdown in text but leaves snake_case alone", () => {
    expect(escapeText("use snake_case and _emph_ [x] <b> # not", true)).toBe(
      "use snake_case and \\_emph\\_ \\[x\\] \\<b> # not",
    );
    expect(escapeText("# heading-like", true)).toBe("\\# heading-like");
    expect(escapeText("1. not a list", true)).toBe("1\\. not a list");
    expect(adfToMarkdown(doc(p(t("- not a bullet"))))).toBe("\\- not a bullet");
  });

  it("survives very deep nesting", () => {
    let node: unknown = p(t("bottom"));
    for (let i = 0; i < 500; i++) node = { type: "blockquote", content: [node] };
    const md = adfToMarkdown(doc(node));
    expect(md).toContain("bottom");
  });

  it("converts the rich fixture with every block in place", () => {
    const md = adfToMarkdown(richDescription);
    expect(md).toContain("## What happens");
    expect(md).toContain("**200 MB**");
    expect(md).toContain("@Ana Ruiz");
    expect(md).toContain("[the runbook](https://example.com/runbook)");
    expect(md).toContain("> **Warning**");
    expect(md).toContain("1. Start an upload");
    expect(md).toContain("   - Shorten it with `SESSION_TTL=60`");
    expect(md).toContain("```ts\nif (!token) return null;\nrefresh(token);\n```");
    expect(md).toContain("| Size | Result |");
    expect(md).toContain("| 100 MB | ok \\| fast |");
    expect(md).toContain("- [x] Reproduce");
    expect(md).toContain("*Attachment: upload-error.png*");
    expect(md).toContain("**Logs**");
    expect(md).toContain("---");
    expect(md).toContain("Unknown nodes keep their text.");
  });
});

describe("adfToPlainText", () => {
  it("collects text across blocks", () => {
    expect(adfToPlainText(doc(p(t("a")), p(t("b"), { type: "mention", attrs: { text: "Ana" } })))).toBe("a\nb@Ana");
  });
});

describe("adfToMarkdown on hostile input", () => {
  it("keeps text from documents nested far beyond any limit", () => {
    let node: unknown = { type: "paragraph", content: [{ type: "text", text: "floor" }] };
    for (let i = 0; i < 20_000; i++) node = { type: "bulletList", content: [{ type: "listItem", content: [node] }] };
    const md = adfToMarkdown({ type: "doc", content: [node] });
    expect(md).toContain("floor");
  });
});
