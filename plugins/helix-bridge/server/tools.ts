// Agent tools. Each acts on the Helix bound to the calling thread (or serving
// its environment) and returns short text for the agent's context.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { QUERY_KINDS } from "../shared/protocol";
import { BridgeFailure, type BoundInstance } from "./bridge";
import { queryText } from "./cli";
import { diagnosticsText, displayPath, panesText, rootsOf, selectionText } from "./format";
import type { HelixService } from "./service";

export const TOOL_NAMES = [
  "helix_selection",
  "helix_show",
  "helix_tour",
  "helix_panes",
  "helix_diagnostics",
  "helix_query",
  "helix_edit",
  "helix_command",
] as const;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

const pathSchema = z.string().min(1).max(4096).describe("File path, relative to the workspace or absolute");
const line = z.number().int().min(1);
const col = z.number().int().min(1);

export const INSTRUCTIONS = [
  "The user's Helix editor is connected to this thread (Helix Bridge).",
  "- To take the user somewhere (\"show me\", \"take me to\"), find the place first (helix_query, or a search), then helix_show it; for several places in order use helix_tour with a note per stop. End your answer with one line saying where the user is now.",
  "- helix_selection tells you what the user is looking at or has selected, with the text. helix_diagnostics and helix_query read the language server Helix already runs; prefer them over starting your own.",
  "- helix_edit is for a change the user should watch happen in their editor; use your normal file tools for bulk edits.",
  "- helix_command is for anything else, under Helix's command policy. Never use it for something a structured tool does, and never retry or work around a refusal.",
  "- A result that says \"deferred\" is not a failure: the user is typing, and Helix shows a prompt (:bb-go) to make the jump.",
].join("\n");

export function registerTools(bb: BbPluginApi, service: HelixService): void {
  const run = (work: (instance: BoundInstance) => Promise<string>) => async (threadId: string): Promise<ToolResult> => {
    try {
      const serving = await service.instancesForThread(threadId);
      const instance = serving[0];
      if (!instance) return text("No Helix editor is connected to this thread. The user can open Helix from the thread's Helix tab, or bind a running one with `bb hx bind`.", true);
      return text(await work(instance));
    } catch (error) {
      if (error instanceof BridgeFailure) {
        const reason = error.name === "unsupported" && error.data && typeof (error.data as { reason?: unknown }).reason === "string" ? `${error.message} (${(error.data as { reason: string }).reason})` : error.message;
        return text(`${error.name}: ${reason}`, true);
      }
      return text(error instanceof Error ? error.message : String(error), true);
    }
  };

  bb.agents.registerTool({
    name: "helix_selection",
    description: "What the user has selected in Helix, or the line under the cursor: file, positions and text, plus the file's unsaved state.",
    presentation: { label: { pending: "Reading the editor selection", completed: "Read the editor selection" } },
    parameters: z.object({ text: z.boolean().default(true).describe("Include the selected text") }).strict(),
    execute: ({ text: withText }, { threadId }) => run(async (instance) => selectionText(await service.selection(instance), instance, withText))(threadId),
  });

  bb.agents.registerTool({
    name: "helix_show",
    description:
      "Take the user to a place in their Helix editor: opens the file, selects the line or range, centres it, optionally in a new split or a given pane, with a one-line note on the status line. Reveals the editor in bb. Reports where the user landed, or that the jump is waiting because they are typing.",
    presentation: { label: { pending: "Showing a place in Helix", completed: "Showed a place in Helix" } },
    parameters: z
      .object({
        path: pathSchema,
        line: line.optional(),
        col: col.optional(),
        endLine: line.optional().describe("Select through this line"),
        endCol: col.optional().describe("End column, exclusive; omit to select through the end of endLine"),
        split: z.enum(["none", "horizontal", "vertical"]).optional().describe("Open in a new split"),
        pane: z.number().int().min(1).optional().describe("Open in this pane (see helix_panes)"),
        note: z.string().max(200).optional().describe("One line shown on the status line, e.g. why this place matters"),
        now: z.boolean().optional().describe("Move even if the user is typing (default: wait; Helix offers :bb-go)"),
      })
      .strict(),
    execute: (args, { threadId }) =>
      run(async (instance) => {
        const result = await service.show(instance, {
          path: args.path,
          ...(args.line !== undefined ? { line: args.line } : {}),
          ...(args.col !== undefined ? { col: args.col } : {}),
          // Without endCol, Helix selects through the end of endLine.
          ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
          ...(args.endLine !== undefined && args.endCol !== undefined ? { endCol: args.endCol } : {}),
          ...(args.split ? { split: args.split } : {}),
          ...(args.pane !== undefined ? { pane: args.pane } : {}),
          ...(args.note ? { note: args.note } : {}),
          interrupt: args.now ? "always" : "whenIdle",
        });
        const where = `${displayPath(result.path, rootsOf(instance))}${args.line ? `:${args.line}${args.endLine ? `-${args.endLine}` : ""}` : ""}`;
        return result.deferred
          ? `Deferred: the user is typing. Helix shows "bb wants to show ${where} (:bb-go)"; tell them to run :bb-go when ready.`
          : `The user is now at ${where}${result.pane ? ` (pane ${result.pane})` : ""}.${result.stale ? " The buffer may be stale: files changed on disk during this turn and reload is not available in this Helix yet; tell the user to run :reload if it looks out of date." : ""}`;
      })(threadId),
  });

  bb.agents.registerTool({
    name: "helix_tour",
    description: "Show the user several places in order, each with a note, and jump to the first. They walk it with :bb-next and :bb-prev (and :bb-locations to pick).",
    presentation: { label: { pending: "Setting up a tour in Helix", completed: "Set up a tour in Helix" } },
    parameters: z
      .object({
        title: z.string().min(1).max(120),
        stops: z
          .array(z.object({ path: pathSchema, line, endLine: line.optional(), note: z.string().min(1).max(200).describe("Why this stop matters, one line") }).strict())
          .min(1)
          .max(100),
        now: z.boolean().optional().describe("Jump even if the user is typing"),
      })
      .strict(),
    execute: (args, { threadId }) =>
      run(async (instance) => {
        const result = await service.tour(instance, {
          title: args.title,
          items: args.stops.map((s, i) => ({ path: s.path, line: s.line, ...(s.endLine ? { endLine: s.endLine } : {}), note: s.note, label: `${i + 1}/${args.stops.length}` })),
          start: 0,
          interrupt: args.now ? "always" : "whenIdle",
        });
        const first = args.stops[0]!;
        return `Tour "${args.title}" with ${result.count} stop${result.count === 1 ? "" : "s"}. ${result.deferred ? `Deferred: the user is typing; Helix offers :bb-go to start at ${first.path}:${first.line}.` : `The user is at stop 1, ${first.path}:${first.line}.`} They continue with :bb-next.`;
      })(threadId),
  });

  bb.agents.registerTool({
    name: "helix_panes",
    description: "List Helix's panes and what each shows; or focus or close one (closing a pane keeps its buffer).",
    presentation: { label: { pending: "Reading Helix panes", completed: "Read Helix panes" } },
    parameters: z.object({ action: z.enum(["list", "focus", "close"]).default("list"), pane: z.number().int().min(1).optional() }).strict(),
    execute: ({ action, pane }, { threadId }) =>
      run(async (instance) => {
        if (action !== "list") {
          if (pane === undefined) throw new BridgeFailure("invalid_params", `pass pane to ${action}`);
          if (action === "focus") {
            const r = await service.focusPane(instance, pane);
            if (r.deferred) return "Deferred: the user is typing; Helix offers :bb-go.";
          } else await service.closePane(instance, pane);
        }
        const { views, layout } = await service.panes(instance);
        return panesText(views, layout, rootsOf(instance));
      })(threadId),
  });

  bb.agents.registerTool({
    name: "helix_diagnostics",
    description: "Diagnostics the user's Helix holds from its language servers, errors first, for one file or the whole workspace.",
    presentation: { label: { pending: "Reading editor diagnostics", completed: "Read editor diagnostics" } },
    parameters: z
      .object({
        path: pathSchema.optional(),
        severity: z.enum(["error", "warning", "info", "hint"]).default("warning").describe("Minimum severity"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
      .strict(),
    execute: (args, { threadId }) =>
      run(async (instance) => {
        const result = await service.diagnostics(instance, { ...(args.path ? { path: args.path } : {}), minSeverity: args.severity, limit: args.limit, offset: args.offset });
        return diagnosticsText(result.items, result.total, rootsOf(instance));
      })(threadId),
  });

  bb.agents.registerTool({
    name: "helix_query",
    description:
      "Ask the language server Helix already runs: definition, typeDefinition, implementation, references, hover, documentSymbols, workspaceSymbols, incomingCalls, outgoingCalls, renamePreview (not applied). Positions are 1-based line and column (characters).",
    presentation: { label: { pending: "Querying the language server", completed: "Queried the language server" } },
    parameters: z
      .object({
        kind: z.enum(QUERY_KINDS),
        path: pathSchema.optional().describe("The file (not needed for workspaceSymbols)"),
        line: line.optional(),
        col: col.optional(),
        query: z.string().max(200).optional().describe("Search text for workspaceSymbols"),
        newName: z.string().max(200).optional().describe("For renamePreview"),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .strict(),
    execute: (args, { threadId }) =>
      run(async (instance) => {
        const result = await service.query(instance, {
          kind: args.kind,
          limit: args.limit,
          ...(args.path ? { path: args.path } : {}),
          ...(args.line !== undefined ? { line: args.line, col: args.col ?? 1 } : {}),
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.newName !== undefined ? { newName: args.newName } : {}),
        });
        return queryText(args.kind, result, rootsOf(instance));
      })(threadId),
  });

  bb.agents.registerTool({
    name: "helix_edit",
    description:
      "Apply edits to a buffer in the user's Helix as one undoable step, so they see the change happen. Ranges refer to the text before any edit, must not overlap, and end exclusive (1-based line and column). Pass version to refuse if the buffer moved on. Leaves the buffer unsaved unless save is true. Use normal file tools for bulk edits.",
    presentation: { label: { pending: "Editing in Helix", completed: "Edited in Helix" } },
    parameters: z
      .object({
        path: pathSchema,
        edits: z
          .array(z.object({ startLine: line, startCol: col, endLine: line, endCol: col, newText: z.string().max(200_000) }).strict())
          .min(1)
          .max(200),
        version: z.number().int().optional(),
        label: z.string().max(80).optional(),
        save: z.boolean().default(false),
      })
      .strict(),
    execute: (args, { threadId }) =>
      run(async (instance) => {
        const result = await service.edit(instance, {
          path: args.path,
          edits: args.edits.map((e) => ({ range: { start: { line: e.startLine, col: e.startCol }, end: { line: e.endLine, col: e.endCol } }, newText: e.newText })),
          ...(args.version !== undefined ? { version: args.version } : {}),
          ...(args.label ? { label: args.label } : {}),
          save: args.save,
        });
        return `Applied ${args.edits.length} edit${args.edits.length === 1 ? "" : "s"} to ${displayPath(result.path, rootsOf(instance))} (version ${result.version}, ${result.modified ? "unsaved" : "saved"}). The user can undo it with u.`;
      })(threadId),
  });

  bb.agents.registerTool({
    name: "helix_command",
    description:
      "Run anything else in Helix: exactly one of a typed command line (without the colon, e.g. \"vsplit src/a.go\"), a static command name from Helix's key maps (e.g. \"goto_definition\"), or keys in Helix notation (e.g. \"<space>f\"). Subject to Helix's command policy; a refusal comes back as the reason and must not be retried or worked around.",
    presentation: { label: { pending: "Running a Helix command", completed: "Ran a Helix command" } },
    parameters: z
      .object({
        typed: z.string().min(1).max(2000).optional(),
        static: z.string().min(1).max(100).optional(),
        count: z.number().int().min(1).max(10000).optional(),
        keys: z.string().min(1).max(500).optional(),
        now: z.boolean().optional().describe("Run even if the user is typing"),
      })
      .strict(),
    execute: (args, { threadId }) =>
      run(async (instance) => {
        const result = await service.command(instance, {
          ...(args.typed !== undefined ? { typed: args.typed } : {}),
          ...(args.static !== undefined ? { static: args.static } : {}),
          ...(args.count !== undefined ? { count: args.count } : {}),
          ...(args.keys !== undefined ? { keys: args.keys } : {}),
          interrupt: args.now ? "always" : "whenIdle",
        });
        if (result.deferred) return "Deferred: the user is typing; Helix offers :bb-go to run it.";
        return result.status ? `Done. Status line: ${result.status.message}` : "Done.";
      })(threadId),
  });
}
