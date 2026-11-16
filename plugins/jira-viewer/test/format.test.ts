import { describe, expect, it } from "vitest";
import { nestHeadings, shellQuote, textQueryJql, truncateMarkdown } from "../src/format.js";

describe("format helpers", () => {
  it("nests headings under their section and leaves code alone", () => {
    const md = "## Top\n\ntext\n\n### Sub\n\n```md\n# not a heading\n```";
    expect(nestHeadings(md, 3)).toBe("### Top\n\ntext\n\n#### Sub\n\n```md\n# not a heading\n```");
    expect(nestHeadings("#### Already deep", 3)).toBe("#### Already deep");
    expect(nestHeadings("no headings", 3)).toBe("no headings");
  });

  it("truncates at a line and closes an open fence", () => {
    const md = `intro\n\`\`\`ts\n${"const x = 1;\n".repeat(50)}\`\`\``;
    const { text, truncated } = truncateMarkdown(md, 200);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(210);
    expect(text.endsWith("```")).toBe(true);
  });

  it("quotes shell arguments and JQL text", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(textQueryJql('say "hi" \\ there')).toBe('text ~ "say \\"hi\\" \\\\ there" ORDER BY updated DESC');
  });
});
