// Atlassian Document Format to Markdown.
//
// Jira Cloud returns descriptions and comments as ADF JSON. The output targets
// bb's Markdown component (CommonMark + GFM tables and task lists) and reads
// cleanly as plain text for agents. Input is untrusted: any field may be
// missing or the wrong type. Unknown nodes degrade to their text, never to
// nothing.

type Json = unknown;

interface AdfNode {
  type: string;
  content: AdfNode[];
  text: string | null;
  attrs: Record<string, unknown>;
  marks: AdfMark[];
}

interface AdfMark {
  type: string;
  attrs: Record<string, unknown>;
}

interface Ctx {
  depth: number;
  /** Inside a table cell: block structure has to fold onto one line. */
  inTable: boolean;
}

const MAX_DEPTH = 48;
/** Beyond this the raw subtree is folded to its text without recursion. */
const MAX_PARSE_DEPTH = 400;

const INLINE_TYPES = new Set([
  "text",
  "hardBreak",
  "mention",
  "emoji",
  "date",
  "status",
  "inlineCard",
  "mediaInline",
  "placeholder",
  "inlineExtension",
]);

const LIST_TYPES = new Set([
  "bulletList",
  "orderedList",
  "taskList",
  "decisionList",
]);

const PANEL_LABELS: Record<string, string> = {
  info: "Info",
  note: "Note",
  tip: "Tip",
  success: "Success",
  warning: "Warning",
  error: "Error",
  custom: "Note",
};

/** Convert an ADF document (or fragment, or plain string) to Markdown. */
export function adfToMarkdown(input: Json): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return escapeText(input, true);
  const ctx: Ctx = { depth: 0, inTable: false };
  let out: string;
  try {
    if (Array.isArray(input)) {
      out = renderBlocks(input.map((value) => toNode(value, 0)).filter(isNode), ctx);
    } else {
      const node = toNode(input, 0);
      if (!node) return "";
      out =
        node.type === "doc" ? renderBlocks(node.content, ctx) : renderBlock(node, ctx);
    }
  } catch {
    // Pathological input: keep the words rather than lose the document.
    out = escapeText(rawText(input), true);
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Plain text of an ADF value: every text-bearing node, separated sensibly. */
export function adfToPlainText(input: Json): string {
  const node = typeof input === "string" ? null : toNode(input, 0);
  if (typeof input === "string") return input;
  if (!node) return "";
  return collectText(node, 0).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------- parsing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNode(node: AdfNode | null): node is AdfNode {
  return node !== null;
}

function toNode(value: unknown, depth: number): AdfNode | null {
  if (typeof value === "string") {
    return { type: "text", content: [], text: value, attrs: {}, marks: [] };
  }
  if (!isRecord(value)) return null;
  if (depth > MAX_PARSE_DEPTH) {
    return { type: "paragraph", content: [{ type: "text", content: [], text: rawText(value), attrs: {}, marks: [] }], text: null, attrs: {}, marks: [] };
  }
  const type = typeof value.type === "string" ? value.type : "unknown";
  const content = Array.isArray(value.content)
    ? value.content.map((child) => toNode(child, depth + 1)).filter(isNode)
    : [];
  const text = typeof value.text === "string" ? value.text : null;
  const attrs = isRecord(value.attrs) ? value.attrs : {};
  const marks = Array.isArray(value.marks)
    ? value.marks
        .filter(isRecord)
        .map((mark) => ({
          type: typeof mark.type === "string" ? mark.type : "unknown",
          attrs: isRecord(mark.attrs) ? mark.attrs : {},
        }))
    : [];
  return { type, content, text, attrs, marks };
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

// ---------------------------------------------------------------- blocks

function renderBlocks(nodes: AdfNode[], ctx: Ctx): string {
  const parts: string[] = [];
  // Consecutive inline nodes at block level (malformed but seen in the wild)
  // render as one paragraph rather than one paragraph per node.
  let inlineRun: AdfNode[] = [];
  const flush = () => {
    if (inlineRun.length === 0) return;
    const text = renderInline(inlineRun, ctx);
    if (text.trim() !== "") parts.push(text);
    inlineRun = [];
  };
  for (const node of nodes) {
    if (INLINE_TYPES.has(node.type)) {
      inlineRun.push(node);
      continue;
    }
    flush();
    const block = renderBlock(node, ctx);
    if (block.trim() !== "") parts.push(block);
  }
  flush();
  return parts.join(ctx.inTable ? " " : "\n\n");
}

function renderBlock(node: AdfNode, parent: Ctx): string {
  const ctx: Ctx = { ...parent, depth: parent.depth + 1 };
  if (ctx.depth > MAX_DEPTH) {
    return escapeText(collectText(node, 0).replace(/\s+/g, " ").trim(), true);
  }
  switch (node.type) {
    case "doc":
    case "layoutSection":
    case "layoutColumn":
    case "bodiedExtension":
    case "multiBodiedExtension":
    case "extensionFrame":
    case "syncBlock":
    case "bodiedSyncBlock":
      return renderBlocks(node.content, ctx);
    case "paragraph":
      return renderInline(node.content, ctx);
    case "heading":
      return renderHeading(node, ctx);
    case "bulletList":
    case "orderedList":
    case "taskList":
    case "decisionList":
      return renderList(node, ctx);
    case "listItem":
    case "taskItem":
    case "decisionItem":
      return renderList(
        { ...node, type: "bulletList", content: [node], attrs: {} },
        ctx,
      );
    case "codeBlock":
      return renderCodeBlock(node, ctx);
    case "blockquote":
      return ctx.inTable
        ? renderBlocks(node.content, ctx)
        : quote(renderBlocks(node.content, ctx));
    case "rule":
      return ctx.inTable ? "" : "---";
    case "panel":
      return renderPanel(node, ctx);
    case "table":
      return ctx.inTable ? renderBlocks(tableCellsInOrder(node), ctx) : renderTable(node, ctx);
    case "tableRow":
    case "tableHeader":
    case "tableCell":
      return renderBlocks(node.content, ctx);
    case "mediaSingle":
    case "mediaGroup":
      return renderMediaGroup(node, ctx);
    case "media":
      return mediaPlaceholder(node);
    case "caption":
      return renderInline(node.content, ctx);
    case "expand":
    case "nestedExpand":
      return renderExpand(node, ctx);
    case "blockCard":
    case "embedCard":
      return renderCard(node);
    case "extension":
      return extensionPlaceholder(node);
    default:
      return renderUnknown(node, ctx);
  }
}

function renderHeading(node: AdfNode, ctx: Ctx): string {
  const text = renderInline(node.content, { ...ctx, inTable: true }).trim();
  if (text === "") return "";
  if (ctx.inTable) return text;
  const raw = Number(node.attrs.level);
  const level = Number.isInteger(raw) ? Math.min(6, Math.max(1, raw)) : 2;
  return `${"#".repeat(level)} ${text}`;
}

function renderCodeBlock(node: AdfNode, ctx: Ctx): string {
  const code = node.content
    .map((child) => child.text ?? collectText(child, 0))
    .join("")
    .replace(/\n+$/, "");
  if (ctx.inTable) return inlineCode(code.replace(/\s*\n\s*/g, " "));
  const language = (str(node.attrs.language) ?? "").replace(/[^\w+#.-]/g, "");
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

function renderPanel(node: AdfNode, ctx: Ctx): string {
  const kind = str(node.attrs.panelType) ?? "info";
  const label = PANEL_LABELS[kind] ?? "Note";
  const body = renderBlocks(node.content, ctx);
  if (ctx.inTable) return `${label}: ${body}`;
  return quote(body === "" ? `**${label}**` : `**${label}**\n\n${body}`);
}

function renderExpand(node: AdfNode, ctx: Ctx): string {
  const title = str(node.attrs.title)?.trim() || "Details";
  const body = renderBlocks(node.content, ctx);
  const heading = `**${escapeText(title, false)}**`;
  if (ctx.inTable) return `${heading} ${body}`;
  return body === "" ? heading : `${heading}\n\n${body}`;
}

function renderCard(node: AdfNode): string {
  const url = str(node.attrs.url);
  const name = isRecord(node.attrs.data) ? str(node.attrs.data.name) : null;
  if (url && safeHref(url)) {
    // A card pointing at a Jira issue reads as its key.
    const key = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)\/?(?:[?#].*)?$/.exec(url)?.[1];
    return link(escapeText(name ?? key ?? url, false), url);
  }
  if (name) return escapeText(name, false);
  return "";
}

function extensionPlaceholder(node: AdfNode): string {
  const text = collectText(node, 0).trim();
  if (text !== "") return escapeText(text, true);
  const key = str(node.attrs.extensionKey) ?? str(node.attrs.extensionType);
  return key ? `*Jira macro: ${escapeText(key, false)}*` : "*Jira macro*";
}

function renderUnknown(node: AdfNode, ctx: Ctx): string {
  if (node.content.length > 0) {
    const allInline = node.content.every((child) => INLINE_TYPES.has(child.type));
    return allInline ? renderInline(node.content, ctx) : renderBlocks(node.content, ctx);
  }
  if (node.text !== null) return renderInline([{ ...node, type: "text" }], ctx);
  const text = str(node.attrs.text);
  if (text) return escapeText(text, true);
  const url = str(node.attrs.url);
  if (url && safeHref(url)) return link(escapeText(url, false), url);
  return "";
}

function quote(body: string): string {
  return body
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

// ---------------------------------------------------------------- lists

function renderList(node: AdfNode, ctx: Ctx): string {
  if (ctx.inTable) {
    return node.content
      .map((item) => {
        const body = LIST_TYPES.has(item.type)
          ? renderList(item, ctx)
          : renderListItemBody(item, ctx);
        return body === "" ? "" : `• ${body}`;
      })
      .filter((part) => part !== "")
      .join(" ");
  }
  const ordered = node.type === "orderedList";
  const rawStart = Number(node.attrs.order);
  let number = Number.isInteger(rawStart) && rawStart >= 0 ? rawStart : 1;
  const items: string[] = [];
  for (const item of node.content) {
    // ADF allows a nested taskList directly inside a taskList; it belongs to
    // the item before it.
    if (LIST_TYPES.has(item.type)) {
      const nested = renderList(item, ctx);
      if (nested === "") continue;
      if (items.length === 0) {
        items.push(nested);
      } else {
        const previous = items[items.length - 1]!;
        const width = markerWidth(previous);
        items[items.length - 1] = `${previous}\n${indent(nested, width)}`;
      }
      continue;
    }
    const marker = ordered
      ? `${number++}. `
      : node.type === "taskList" || item.type === "taskItem"
        ? str(item.attrs.state) === "DONE"
          ? "- [x] "
          : "- [ ] "
        : "- ";
    const body = renderListItemBody(item, ctx);
    items.push(`${marker}${indent(body, marker.length).trimStart()}`);
  }
  return items.join("\n");
}

function renderListItemBody(item: AdfNode, ctx: Ctx): string {
  if (item.type === "taskItem" || item.type === "decisionItem") {
    // These hold inline content directly, sometimes followed by blocks.
    return renderBlocks(item.content, ctx);
  }
  if (item.type !== "listItem") return renderBlock(item, ctx);
  const parts: string[] = [];
  let previousWasList = false;
  for (const child of item.content) {
    const isList = LIST_TYPES.has(child.type);
    const text = renderBlock(child, { ...ctx, depth: ctx.depth + 1 });
    if (text.trim() === "") continue;
    if (parts.length > 0) {
      // Tight: a paragraph followed by its nested list. Loose otherwise.
      parts.push(isList || previousWasList ? "\n" : "\n\n");
    }
    parts.push(text);
    previousWasList = isList;
  }
  return parts.join("");
}

function markerWidth(item: string): number {
  const match = /^(\d+\. |- \[[ x]\] |- )/.exec(item);
  return match ? match[1]!.length : 2;
}

function indent(text: string, width: number): string {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : pad + line))
    .join("\n");
}

// ---------------------------------------------------------------- tables

function tableCellsInOrder(table: AdfNode): AdfNode[] {
  return table.content.flatMap((row) => row.content);
}

function renderTable(node: AdfNode, ctx: Ctx): string {
  const cellCtx: Ctx = { ...ctx, inTable: true };
  const rows: string[][] = [];
  for (const row of node.content) {
    if (row.type !== "tableRow") continue;
    const cells: string[] = [];
    for (const cell of row.content) {
      const text = renderBlocks(cell.content, cellCtx)
        .replace(/\s*\n\s*/g, " ")
        .replace(/\|/g, "\\|")
        .trim();
      cells.push(text);
      const span = Number(cell.attrs.colspan);
      if (Number.isInteger(span) && span > 1) {
        for (let i = 1; i < Math.min(span, 64); i++) cells.push("");
      }
    }
    rows.push(cells);
  }
  if (rows.length === 0) return "";
  const width = Math.max(1, ...rows.map((row) => row.length));
  const line = (cells: string[]) => {
    const padded = [...cells];
    while (padded.length < width) padded.push("");
    return `| ${padded.map((cell) => cell || " ").join(" | ")} |`;
  };
  const [header, ...body] = rows;
  return [
    line(header!),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

// ---------------------------------------------------------------- media

function renderMediaGroup(node: AdfNode, ctx: Ctx): string {
  const parts: string[] = [];
  for (const child of node.content) {
    const text =
      child.type === "media" ? mediaPlaceholder(child) : renderBlock(child, ctx);
    if (text.trim() !== "") parts.push(text);
  }
  return parts.join(ctx.inTable ? " " : "\n");
}

function mediaPlaceholder(node: AdfNode): string {
  const name = str(node.attrs.alt) ?? str(node.attrs.filename) ?? str(node.attrs.name);
  const url = str(node.attrs.url);
  const label = name ? `Attachment: ${escapeText(name, false)}` : "Attachment";
  if (str(node.attrs.type) === "external" && url && safeHref(url)) {
    return link(name ? `Image: ${escapeText(name, false)}` : "Image", url);
  }
  return `*${label}*`;
}

// ---------------------------------------------------------------- inline

function renderInline(nodes: AdfNode[], ctx: Ctx): string {
  const merged = mergeTextRuns(nodes);
  let out = "";
  let atLineStart = true;
  const breakText = ctx.inTable ? " " : "\\\n";
  for (const node of merged) {
    let piece: string;
    switch (node.type) {
      case "text": {
        const lines = (node.text ?? "").split(/\r?\n/);
        piece = lines
          .map((line, index) =>
            applyMarks(line, node.marks, atLineStart || index > 0),
          )
          .join(breakText);
        break;
      }
      case "hardBreak":
        out += breakText;
        atLineStart = !ctx.inTable;
        continue;
      case "mention": {
        const text = str(node.attrs.text) ?? str(node.attrs.displayName);
        const name = text ? text.replace(/^@/, "") : "someone";
        piece = `@${escapeText(name, false)}`;
        break;
      }
      case "emoji":
        piece = str(node.attrs.text) ?? str(node.attrs.shortName) ?? "";
        break;
      case "date":
        piece = formatDate(node.attrs.timestamp);
        break;
      case "status": {
        const text = str(node.attrs.text);
        piece = text ? inlineCode(text) : "";
        break;
      }
      case "inlineCard":
        piece = renderCard(node);
        break;
      case "mediaInline":
        piece = mediaPlaceholder(node);
        break;
      case "placeholder":
        piece = "";
        break;
      case "inlineExtension":
        piece = extensionPlaceholder(node);
        break;
      default: {
        if (ctx.depth > MAX_DEPTH) {
          piece = escapeText(collectText(node, 0), false);
        } else if (node.content.length > 0) {
          piece = renderInline(node.content, { ...ctx, depth: ctx.depth + 1 });
        } else if (node.text !== null) {
          piece = applyMarks(node.text, node.marks, atLineStart);
        } else {
          piece = escapeText(str(node.attrs.text) ?? "", atLineStart);
        }
      }
    }
    if (piece === "") continue;
    out += piece;
    atLineStart = false;
  }
  // A trailing hard break would render a literal backslash.
  while (out.endsWith(breakText) && breakText !== " ") {
    out = out.slice(0, -breakText.length);
  }
  return out;
}

/** Merge adjacent text nodes with identical marks so `**a****b**` never happens. */
function mergeTextRuns(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const node of nodes) {
    const previous = out[out.length - 1];
    if (
      node.type === "text" &&
      previous?.type === "text" &&
      sameMarks(previous.marks, node.marks)
    ) {
      out[out.length - 1] = {
        ...previous,
        text: (previous.text ?? "") + (node.text ?? ""),
      };
    } else {
      out.push(node);
    }
  }
  return out;
}

function sameMarks(a: AdfMark[], b: AdfMark[]): boolean {
  if (a.length !== b.length) return false;
  const key = (marks: AdfMark[]) =>
    marks
      .map((mark) => `${mark.type}:${JSON.stringify(mark.attrs)}`)
      .sort()
      .join("|");
  return key(a) === key(b);
}

function applyMarks(raw: string, marks: AdfMark[], atLineStart: boolean): string {
  if (raw === "") return "";
  const types = new Set(marks.map((mark) => mark.type));
  const linkMark = marks.find((mark) => mark.type === "link");
  const href = linkMark ? str(linkMark.attrs.href) : null;

  if (types.has("code")) {
    const code = inlineCode(raw);
    return href && safeHref(href) ? link(code, href) : code;
  }
  // Emphasis delimiters cannot sit against whitespace, so hoist it outside.
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw)!;
  const [, lead, core, trail] = match;
  if (core === "") return raw;
  let text = escapeText(core!, atLineStart && lead === "");
  if (types.has("em")) text = `*${text}*`;
  if (types.has("strong")) text = `**${text}**`;
  if (types.has("strike")) text = `~~${text}~~`;
  if (href && safeHref(href)) text = link(text, href);
  return `${lead}${text}${trail}`;
}

function inlineCode(text: string): string {
  if (text === "") return "";
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function link(text: string, href: string): string {
  const target = /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href;
  return `[${text}](${target})`;
}

/** Only http(s), mailto and plain relative links survive. */
export function safeHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed === "") return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!scheme) return true;
  return ["http", "https", "mailto"].includes(scheme[1]!.toLowerCase());
}

function formatDate(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return str(value) ?? "";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/**
 * Escape Markdown syntax in plain text. Kept narrow so agents reading raw
 * output see little noise: `_` is only escaped where it could open emphasis.
 */
export function escapeText(text: string, atLineStart: boolean): string {
  let out = text
    .replace(/\\/g, "\\\\")
    .replace(/([`*[\]<]|~~)/g, (match) =>
      match === "~~" ? "\\~\\~" : `\\${match}`,
    )
    .replace(/(^|[^\p{L}\p{N}])_|_(?=$|[^\p{L}\p{N}])/gu, (match) =>
      match.replace("_", "\\_"),
    );
  if (atLineStart) {
    out = out
      .replace(/^(\s*)([#>])/, "$1\\$2")
      .replace(/^(\s*)([-+])(\s|$)/, "$1\\$2$3")
      .replace(/^(\s*)(\d+)([.)])(\s|$)/, "$1$2\\$3$4")
      .replace(/^(\s*)(={3,}|-{3,})\s*$/, "$1\\$2");
  }
  return out;
}

/** Every `text` string in raw JSON, gathered with an explicit stack. */
function rawText(value: unknown): string {
  const parts: string[] = [];
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0 && visited++ < 200_000) {
    const current = stack.pop();
    if (!isRecord(current)) continue;
    if (typeof current.text === "string") parts.push(current.text);
    else if (isRecord(current.attrs) && typeof current.attrs.text === "string") parts.push(current.attrs.text);
    if (Array.isArray(current.content)) {
      for (let i = current.content.length - 1; i >= 0; i--) stack.push(current.content[i]);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function collectText(node: AdfNode, depth: number): string {
  if (depth > MAX_PARSE_DEPTH + 10) return "";
  if (node.text !== null) return node.text;
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") {
    const text = str(node.attrs.text);
    return text ? (text.startsWith("@") ? text : `@${text}`) : "";
  }
  const own = str(node.attrs.text) ?? "";
  if (node.content.length === 0) return own;
  const separator = INLINE_TYPES.has(node.content[0]!.type) ? "" : "\n";
  return node.content.map((child) => collectText(child, depth + 1)).join(separator);
}
