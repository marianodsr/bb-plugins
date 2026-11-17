// Plain-text output for the CLI and agent tools: locations as `path:line`
// with the preview line, counts capped with "N more", never raw protocol JSON.
import type { Diagnostic, LayoutNode, Location, Range, SelectionResult, SymbolInfo, ViewInfo } from "../shared/protocol";
import type { BoundInstance } from "./bridge";
import { within } from "./bridge";

export const MAX_ITEMS = 50;
export const MAX_CODE_LINES = 200;

/** Relative to the first root that contains it, else absolute. */
export function displayPath(path: string | null | undefined, roots: readonly (string | null | undefined)[]): string {
  if (!path) return "(scratch buffer)";
  for (const root of roots) {
    if (root && within(root, path) && path !== root) return path.slice(root.replace(/\/$/u, "").length + 1);
  }
  return path;
}

export function rootsOf(instance: BoundInstance): string[] {
  return [instance.environmentPath, instance.summary.workspaceRoot].filter((r): r is string => Boolean(r));
}

export function lineSpan(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

/** The lines a range covers; an end at column 1 of a later line stops before it. */
export function rangeLines(range: Range): { start: number; end: number } {
  const end = range.end.line > range.start.line && range.end.col === 1 ? range.end.line - 1 : range.end.line;
  return { start: range.start.line, end: Math.max(range.start.line, end) };
}

export function more(total: number, shown: number, hint = ""): string[] {
  return total > shown ? [`... ${total - shown} more${hint ? `; ${hint}` : ""}`] : [];
}

export function instanceLine(instance: BoundInstance, threadTitle?: string | null): string {
  const s = instance.summary;
  const where = s.focus?.path ? `${displayPath(s.focus.path, rootsOf(instance))}${s.focus.cursor ? `:${s.focus.cursor.line}` : ""}` : "no file";
  const thread = instance.threadId ? `${instance.threadId}${threadTitle ? ` "${threadTitle}"` : ""} (${instance.bindingSource})` : "not bound";
  const status = s.status === "connected" ? "" : `  [${s.status}${s.error ? `: ${s.error}` : ""}]`;
  return `${instance.key}  pid ${s.pid}  ${s.workspaceRoot ?? s.cwd ?? "?"}  ${where}  -> ${thread}${status}`;
}

export function stateText(instance: BoundInstance, threadTitle?: string | null): string {
  const s = instance.summary;
  const roots = rootsOf(instance);
  const out = [
    `Helix ${s.helixVersion ?? "?"} pid ${s.pid} on ${instance.hostId} (${s.status}${s.error ? `: ${s.error}` : ""})`,
    `workspace: ${s.workspaceRoot ?? "?"}${s.cwd && s.cwd !== s.workspaceRoot ? `  cwd: ${s.cwd}` : ""}`,
    `thread: ${instance.threadId ? `${instance.threadId}${threadTitle ? ` "${threadTitle}"` : ""}, bound by ${bindingLabel(instance)}` : "not bound to a thread (bb hx bind)"}`,
  ];
  if (s.focus) {
    const cursor = s.focus.cursor ? `:${s.focus.cursor.line}:${s.focus.cursor.col}` : "";
    const extent = s.focus.anchor ? ` to ${s.focus.anchor.line}:${s.focus.anchor.col}` : "";
    out.push(`focused: ${displayPath(s.focus.path, roots)}${cursor}${extent}${s.focus.modified ? " (unsaved changes)" : ""}${s.focus.selections > 1 ? `, ${s.focus.selections} selections` : ""}`);
  }
  out.push(`mode: ${s.mode ?? "?"}  open buffers: ${s.documents}  diagnostics: ${s.diagnostics.errors} errors, ${s.diagnostics.warnings} warnings`);
  out.push(`capabilities: ${s.capabilities.join(", ") || "none"}  command policy: ${s.commandPolicy ?? "n/a"}`);
  if (s.lspServers.length) out.push(`language servers: ${s.lspServers.join(", ")}`);
  if (s.externalChanges.length) out.push(`changed on disk while unsaved: ${s.externalChanges.slice(0, 5).map((p) => displayPath(p, roots)).join(", ")}`);
  if (s.overflows) out.push(`event overflows: ${s.overflows} (${s.dropped} dropped, state resynced)`);
  return out.join("\n");
}

export function bindingLabel(instance: BoundInstance): string {
  switch (instance.bindingSource) {
    case "terminal":
      return "its bb terminal";
    case "explicit":
      return "bb hx bind";
    case "environment":
      return "workspace (latest thread in the environment)";
    default:
      return "nothing";
  }
}

export function fence(code: string, languageId: string | null | undefined): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/gu)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${languageId && languageId !== "text" ? languageId : ""}\n${code}\n${ticks}`;
}

export function capLines(text: string, max = MAX_CODE_LINES): { text: string; dropped: number } {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, dropped: 0 };
  return { text: lines.slice(0, max).join("\n"), dropped: lines.length - max };
}

export function selectionText(selection: SelectionResult, instance: BoundInstance, withText = true): string {
  const roots = rootsOf(instance);
  const path = displayPath(selection.path, roots);
  const out = [`${path}${selection.modified ? " (unsaved changes)" : ""}, ${selection.ranges.length} selection${selection.ranges.length === 1 ? "" : "s"}`];
  const cursorsOnly = selection.ranges.every((r) => r.start.line === r.end.line && r.start.col === r.end.col);
  selection.ranges.slice(0, 10).forEach((range, index) => {
    const lines = rangeLines(range);
    const label = cursorsOnly ? `cursor at ${path}:${range.start.line}:${range.start.col}` : `${path}:${lineSpan(lines.start, lines.end)} (${range.start.line}:${range.start.col} to ${range.end.line}:${range.end.col})`;
    out.push(`${index === selection.primary ? "* " : "  "}${label}`);
    if (withText && range.text) {
      const capped = capLines(range.text);
      out.push(fence(capped.text, selection.languageId));
      if (capped.dropped) out.push(`(${capped.dropped} more lines not shown)`);
    }
  });
  out.push(...more(selection.ranges.length, 10));
  if (selection.truncated) out.push("(the editor truncated the text at 1 MiB)");
  return out.join("\n");
}

export function locationsText(locations: Location[], total: number, roots: string[], max = MAX_ITEMS): string {
  if (locations.length === 0) return "No results.";
  const shown = locations.slice(0, max).map((l) => `${displayPath(l.path, roots)}:${l.range.start.line}:${l.range.start.col}  ${l.preview.trim()}`);
  return [...shown, ...more(Math.max(total, locations.length), shown.length, "pass a larger limit or narrow the query")].join("\n");
}

export function symbolsText(symbols: SymbolInfo[], total: number, roots: string[], max = MAX_ITEMS): string {
  if (symbols.length === 0) return "No symbols.";
  const shown = symbols.slice(0, max).map((s) => `${s.kind} ${s.container ? `${s.container}.` : ""}${s.name}  ${displayPath(s.location.path, roots)}:${s.location.range.start.line}`);
  return [...shown, ...more(Math.max(total, symbols.length), shown.length)].join("\n");
}

export function diagnosticsText(items: Diagnostic[], total: number, roots: string[]): string {
  if (items.length === 0) return "No diagnostics.";
  const shown = items.map((d) => `${d.severity.padEnd(7)} ${displayPath(d.path, roots)}:${d.range.start.line}:${d.range.start.col}  ${d.message.split("\n")[0]}${d.source ? ` [${d.source}${d.code !== undefined ? ` ${d.code}` : ""}]` : ""}`);
  return [...shown, ...more(total, items.length, "pass offset to page, or path to narrow")].join("\n");
}

export function panesText(views: ViewInfo[], layout: LayoutNode | null, roots: string[]): string {
  const lines = views.map((v) => `${v.focused ? "*" : " "} pane ${v.viewId}  ${displayPath(v.path, roots)}  lines ${v.firstLine}-${v.lastLine}`);
  const describe = (node: LayoutNode): string => ("viewId" in node ? `${node.viewId}` : `${node.split}(${node.children.map(describe).join(", ")})`);
  if (layout) lines.push(`layout: ${describe(layout)}`);
  return lines.join("\n");
}
