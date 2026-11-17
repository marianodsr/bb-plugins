// Agent tools. Each acts on the Helix bound to the calling thread (or serving
// its environment) and returns short text for the agent's context.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { QUERY_KINDS } from "../shared/protocol";
import { BridgeFailure, type BoundInstance } from "./bridge";
import { queryText } from "./cli";
import { diagnosticsText, displayPath, panesText, rootsOf, selectionText } from "./format";
import { commandText, type HelixService } from "./service";

export const TOOL_NAMES = [
  "helix_selection",
  "helix_show",
  "helix_tour",
  "helix_panes",
  "helix_diagnostics",
  "helix_query",
  "helix_edit",
  "helix_command",
  "helix_review",
] as const;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

const pathSchema = z.string().min(1).max(4096).describe("Relative to the workspace, or absolute");
const line = z.number().int().min(1);
const col = z.number().int().min(1);

/**
 * The instruction a session gets with the tools: kept to what changes how an
 * agent works (every line is context in every thread). Edit files with your
 * normal tools: Helix shows the change by itself.
 */
export function instructionsFor(tools: readonly string[]): string {
  const has = (name: string) => tools.includes(name);
  return [
    "The user's Helix editor is connected (Helix Bridge). Edit files with your normal tools; Helix shows the changes.",
    "To take the user somewhere, find it (helix_query or a search), then helix_show it" + (has("helix_tour") ? ", or helix_tour for several places" : "") + "; end with one line saying where they are.",
    "helix_selection: what they are looking at." + (has("helix_query") ? " helix_query and helix_diagnostics use the language server Helix already runs." : ""),
    ...(has("helix_command") ? ["helix_command: anything else, under Helix's command policy; never work around a refusal."] : []),
  ].join("\n");
}

/** The instruction with every tool offered (tests, docs). */
export const INSTRUCTIONS = instructionsFor(TOOL_NAMES);

export interface ToolHooks {
  /** Start or end a review in this Helix; the status text. */
  review?(instance: BoundInstance, target: string): Promise<string>;
}

export function registerTools(bb: BbPluginApi, service: HelixService, hooks: ToolHooks = {}): void {
  const run = (work: (instance: BoundInstance) => Promise<string>) => async (threadId: string): Promise<ToolResult> => {
    try {
      const serving = await service.instancesForThread(threadId);
      const instance = serving[0];
      if (!instance) return text("No Helix editor is connected to this thread. The user can open Helix from the thread's Helix tab, or bind a running one with `bb hx bind`.", true);
      return text(await work(instance));
    } catch (error) {
      if (error instanceof BridgeFailure) {
        const given = error.name === "unsupported" && error.data && typeof (error.data as { reason?: unknown }).reason === "string" ? (error.data as { reason: string }).reason : null;
        const reason = given && !error.message.includes(given) ? `${error.message} (${given})` : error.message;
        return text(`${error.name}: ${reason}`, true);
      }
      return text(error instanceof Error ? error.message : String(error), true);
    }
  };

  bb.agents.registerTool({
    name: "helix_selection",
    description: "What the user has selected in Helix (or the cursor line): file, lines and text.",
    presentation: { label: { pending: "Reading the editor selection", completed: "Read the editor selection" } },
    parameters: z.object({ text: z.boolean().default(true).describe("Include the selected text") }).strict(),
    execute: ({ text: withText }, { threadId }) => run(async (instance) => selectionText(await service.selection(instance), instance, withText))(threadId),
  });

  bb.agents.registerTool({
    name: "helix_show",
    description: "Take the user to a file and line (or lines line-endLine) in their Helix, with an optional one-line note.",
    presentation: { label: { pending: "Showing a place in Helix", completed: "Showed a place in Helix" } },
    parameters: z
      .object({
        path: pathSchema,
        line: line.optional(),
        endLine: line.optional(),
        split: z.enum(["vertical", "horizontal"]).optional(),
        note: z.string().max(200).optional(),
        now: z.boolean().optional().describe("Move even if the user is typing"),
      })
      .strict(),
    execute: (args, { threadId }) =>
      run(async (instance) => {
        const result = await service.show(instance, {
          path: args.path,
          ...(args.line !== undefined ? { line: args.line } : {}),
          // Helix selects lines line to endLine whole.
          ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
          ...(args.split ? { split: args.split } : {}),
          ...(args.note ? { note: args.note } : {}),
          interrupt: args.now ? "always" : "whenIdle",
        });
        const where = `${displayPath(result.path, rootsOf(instance))}${args.line ? `:${args.line}${args.endLine ? `-${args.endLine}` : ""}` : ""}`;
        return result.deferred
          ? `Deferred: the user is busy (typing, a prompt open or a key sequence half typed). Helix shows "bb wants to show ${where} (:bb-go)"; tell them to run :bb-go when ready.`
          : `The user is now at ${where}${result.pane ? ` (pane ${result.pane})` : ""}.${result.stale ? " The buffer may be stale: files changed on disk during this turn and reload is not available in this Helix yet; tell the user to run :reload if it looks out of date." : ""}`;
      })(threadId),
  });

  bb.agents.registerTool({
    name: "helix_tour",
    description: "Show the user several places in order, each with a note; they walk it with :bb-next.",
    presentation: { label: { pending: "Setting up a tour in Helix", completed: "Set up a tour in Helix" } },
    parameters: z
      .object({
        title: z.string().min(1).max(120),
        stops: z
          .array(z.object({ path: pathSchema, line, endLine: line.optional(), note: z.string().min(1).max(200) }).strict())
          .min(1)
          .max(100),
        now: z.boolean().optional(),
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
        return `Tour "${args.title}" with ${result.count} stop${result.count === 1 ? "" : "s"}. ${result.deferred ? `Deferred: the user is busy (typing, a prompt open or a key sequence half typed); Helix offers :bb-go to start at ${first.path}:${first.line}.` : `The user is at stop 1, ${first.path}:${first.line}.`} They continue with :bb-next.`;
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
            if (r.deferred) return "Deferred: the user is busy (typing, a prompt open or a key sequence half typed); Helix offers :bb-go.";
          } else {
            const r = await service.closePane(instance, pane);
            if (r.deferred) return "Deferred: the user is busy (typing, a prompt open or a key sequence half typed); Helix offers :bb-go to close it.";
          }
        }
        const { views, layout } = await service.panes(instance);
        return panesText(views, layout, rootsOf(instance));
      })(threadId),
  });

  bb.agents.registerTool({
    name: "helix_diagnostics",
    description: "Language-server diagnostics in the user's Helix, errors first, for a file or the workspace.",
    presentation: { label: { pending: "Reading editor diagnostics", completed: "Read editor diagnostics" } },
    parameters: z
      .object({
        path: pathSchema.optional(),
        severity: z.enum(["error", "warning", "info", "hint"]).default("warning"),
      })
      .strict(),
    execute: (args, { threadId }) =>
      run(async (instance) => {
        const result = await service.diagnostics(instance, { ...(args.path ? { path: args.path } : {}), minSeverity: args.severity, limit: 50, offset: 0 });
        return diagnosticsText(result.items, result.total, rootsOf(instance));
      })(threadId),
  });

  bb.agents.registerTool({
    name: "helix_query",
    description: "Ask the language server Helix runs (renamePreview is not applied). Line and col are 1-based.",
    presentation: { label: { pending: "Querying the language server", completed: "Queried the language server" } },
    parameters: z
      .object({
        kind: z.enum(QUERY_KINDS),
        path: pathSchema.optional(),
        line: line.optional(),
        col: col.optional(),
        query: z.string().max(200).optional().describe("workspaceSymbols"),
        newName: z.string().max(200).optional().describe("renamePreview"),
      })
      .strict(),
    execute: (args, { threadId }) =>
      run(async (instance) => {
        const result = await service.query(instance, {
          kind: args.kind,
          limit: 50,
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
        now: z.boolean().optional().describe("Run even if the user is busy"),
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
        return commandText(result);
      })(threadId),
  });

  bb.agents.registerTool({
    name: "helix_review",
    description: "Show the user changes as a review in Helix: target uncommitted, branch, pr, turn (your last turn), commit <sha>, or off.",
    presentation: { label: { pending: "Starting a review in Helix", completed: "Started a review in Helix" } },
    parameters: z.object({ target: z.string().min(1).max(240) }).strict(),
    execute: ({ target }, { threadId }) =>
      run(async (instance) => {
        if (!hooks.review) throw new BridgeFailure("unsupported", "reviews are not available");
        return hooks.review(instance, target);
      })(threadId),
  });
}
