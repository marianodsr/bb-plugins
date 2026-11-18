// `bb hx`: the same operations as the agent tools and the app, for shells
// and agents. Every command takes --instance (a key, an id or a pid); without
// it the instance bound to the calling thread is used, or the only one.
import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { QUERY_KINDS, type Location, type QueryKind, type SymbolInfo } from "../shared/protocol";
import { BridgeFailure, type BoundInstance } from "./bridge";
import {
  diagnosticsText,
  displayPath,
  instanceLine,
  locationsText,
  more,
  panesText,
  rootsOf,
  selectionText,
  stateText,
  symbolsText,
} from "./format";
import { commandText, type HelixService } from "./service";

const instanceOption = { type: "string" as const, description: "Helix instance: its key (host:pid), id or pid. Default: the one bound to this thread, or the only one", aliases: ["i", "pid"] };

function fail(message: string, code: string, hint?: string): never {
  throw new PluginCliError(message, { code, ...(hint ? { hint } : {}) });
}

async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    if (error instanceof BridgeFailure) fail(error.message, error.name, error.name === "ambiguous" ? "Pass --instance, or bind one: bb hx bind --instance <pid>" : undefined);
    fail(error instanceof Error ? error.message : String(error), "failed");
  }
}

/** `path[:line[:col]]`; a trailing `:line-endLine` selects lines. */
export function parseLocation(value: string): { path: string; line?: number; col?: number; endLine?: number } {
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?(?::(\d+))?)?$/u.exec(value.trim());
  if (!match || !match[1]) fail(`"${value}" is not a location`, "invalid_location", "Use path, path:line or path:line:col");
  const out: { path: string; line?: number; col?: number; endLine?: number } = { path: match[1] };
  if (match[2]) out.line = Number(match[2]);
  if (match[3]) out.endLine = Number(match[3]);
  if (match[4]) out.col = Number(match[4]);
  return out;
}

export function queryText(kind: QueryKind, result: Record<string, unknown>, roots: string[]): string {
  if (kind === "hover") return String(result.markdown ?? "") || "No hover information.";
  if (kind === "documentSymbols" || kind === "workspaceSymbols") return symbolsText((result.symbols ?? []) as SymbolInfo[], Number(result.total ?? 0), roots);
  if (kind === "incomingCalls" || kind === "outgoingCalls") {
    const calls = (result.calls ?? []) as { name: string; kind: string; location: Location; callSites?: Location[] }[];
    if (calls.length === 0) return "No calls.";
    const shown = calls.slice(0, 50).map((c) => {
      const sites = c.callSites ?? [];
      const at = sites.length > 0 ? `, called at ${sites.slice(0, 5).map((s) => `${displayPath(s.path, roots)}:${s.range.start.line}`).join(", ")}${sites.length > 5 ? ` and ${sites.length - 5} more` : ""}` : "";
      return `${c.name}  ${displayPath(c.location.path, roots)}:${c.location.range.start.line}${at}  ${c.location.preview.trim()}`;
    });
    return [...shown, ...more(Number(result.total ?? calls.length), shown.length)].join("\n");
  }
  if (kind === "renamePreview") {
    const edits = (result.edits ?? []) as { path: string; range: { start: { line: number; col: number } }; newText: string }[];
    if (edits.length === 0) return "Nothing to rename.";
    const shown = edits.slice(0, 50).map((e) => `${displayPath(e.path, roots)}:${e.range.start.line}:${e.range.start.col} -> ${e.newText}`);
    // `files` is the sorted list of paths touched (a count in early mocks).
    const files = Array.isArray(result.files) ? result.files.length : Number(result.files ?? 0);
    const total = Number(result.total ?? edits.length);
    const operations = ((result.fileOperations ?? []) as { kind: string; path: string; newPath?: string }[]).map((op) => `${op.kind} ${displayPath(op.path, roots)}${op.newPath ? ` -> ${displayPath(op.newPath, roots)}` : ""}`);
    return [`${total} edit${total === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"} (not applied)`, ...operations, ...shown, ...more(total, shown.length)].join("\n");
  }
  return locationsText((result.locations ?? []) as Location[], Number(result.total ?? 0), roots);
}

export interface CliHooks {
  /** Start or end a review; the status text. */
  review?(instance: BoundInstance, target: string): Promise<string>;
  /** Lines for bb hx doctor about this bb's own costs (a slow turn snapshot). */
  notes?(): string[];
}

export function registerCli(bb: BbPluginApi, service: HelixService, hooks: CliHooks = {}): void {
  const target = (instance: string | undefined, threadId: string | undefined) => service.target({ instance, threadId });
  const titleOf = async (instance: BoundInstance) => (instance.threadId ? (await service.threadInfo(instance.threadId)).title : null);

  bb.cli.register(
    defineCli({
      name: "hx",
      summary: "Helix Bridge: see and drive the Helix editor connected to bb (list, state, open, selection, diagnostics, language-server queries, bind, doctor)",
      commands: {
        list: cliCommand({
          summary: "Helix instances on every machine and the thread each one is bound to",
          options: {},
          async run() {
            return guard(async () => {
              await service.bridge.reconcile();
              const all = service.bridge.list();
              const hosts = service.bridge.hostStates();
              if (all.length === 0) {
                const dirs = hosts.map((h) => `${h.hostId}: ${h.bridgeDir}${h.dirExists ? "" : " (does not exist yet)"}${h.error ? ` [${h.error}]` : ""}`);
                return { exitCode: 0, stdout: `No Helix with the bridge is running.\n${dirs.join("\n")}\nStart hxb, or run bb hx doctor.` };
              }
              const lines = await Promise.all(all.map(async (i) => instanceLine(i, await titleOf(i))));
              return { exitCode: 0, stdout: lines.join("\n") };
            });
          },
        }),
        state: cliCommand({
          summary: "What one Helix shows: focused file and cursor, mode, diagnostics, capabilities, binding",
          options: { instance: instanceOption },
          async run({ options }, ctx) {
            return guard(async () => {
              const instance = await target(options.instance, ctx.threadId);
              return { exitCode: 0, stdout: stateText(instance, await titleOf(instance), service.bridge.signalCounts.get(instance.hostId)) };
            });
          },
        }),
        open: cliCommand({
          summary: "Open a file in Helix at a line (path[:line[:col]] or path:line-endLine)",
          positionals: [{ name: "location", description: "path, path:line, path:line:col or path:line-endLine; relative to the thread's workspace", required: true }],
          options: {
            instance: instanceOption,
            split: { type: "enum", values: ["none", "horizontal", "vertical"], description: "Open in a new split" },
            note: { type: "string", description: "One line shown on Helix's status line" },
            now: { type: "boolean", description: "Move even if the user is busy (default: wait for them, Helix shows :bb-go)" },
          },
          async run({ positionals, options }, ctx) {
            return guard(async () => {
              const instance = await target(options.instance, ctx.threadId);
              const location = parseLocation(positionals.location);
              const result = await service.show(instance, {
                ...location,
                ...(options.split ? { split: options.split as "none" | "horizontal" | "vertical" } : {}),
                ...(options.note ? { note: options.note } : {}),
                interrupt: options.now ? "always" : "whenIdle",
              });
              const where = `${displayPath(result.path, rootsOf(instance))}${location.line ? `:${location.line}${location.endLine ? `-${location.endLine}` : ""}` : ""}`;
              const stale = result.stale ? "\nThe buffer may be stale: files changed on disk during an agent's turn and reload is not available in this Helix yet (:reload)." : "";
              return { exitCode: 0, stdout: result.deferred ? `Deferred: the user is busy (typing, a prompt open or a key sequence half typed). Helix shows "bb wants to show ${where} (:bb-go)".` : `Opened ${where}${result.pane && options.split && options.split !== "none" ? ` in pane ${result.pane}` : ""}.${stale}` };
            });
          },
        }),
        review: cliCommand({
          summary: "Show the user changes as a review in their Helix: uncommitted, branch, pr, turn, commit <sha>, or off",
          positionals: [{ name: "target", description: "uncommitted (default), branch, pr, turn, commit <sha>, off", variadic: true }],
          options: { instance: instanceOption },
          async run({ positionals, options }, ctx) {
            return guard(async () => {
              if (!hooks.review) fail("reviews are not available", "unsupported");
              const instance = await target(options.instance, ctx.threadId);
              return { exitCode: 0, stdout: await hooks.review!(instance, positionals.target.join(" ") || "uncommitted") };
            });
          },
        }),
        tour: cliCommand({
          summary: "Take the user through several places in order, each with a note; jumps to the first (they continue with :bb-next)",
          positionals: [{ name: "stops", description: 'Stops as "path:line[-endLine] note", one per argument', variadic: true }],
          options: {
            instance: instanceOption,
            title: { type: "string", description: "The tour's title (default: Tour)" },
            stops: { type: "string", description: 'Stops, one per line: "path:line[-endLine] note"', stdin: true },
            now: { type: "boolean", description: "Jump even if the user is busy" },
          },
          async run({ positionals, options }, ctx) {
            return guard(async () => {
              const lines = [...positionals.stops, ...(options.stops ?? "").split("\n")].map((l) => l.trim()).filter(Boolean);
              if (lines.length === 0) fail("no stops", "invalid_params", 'Pass stops as "path:line note" arguments, or one per line with --stops-stdin');
              const items = lines.map((l, i) => {
                const [location = "", ...note] = l.split(/\s+/u);
                const parsed = parseLocation(location);
                if (!parsed.line) fail(`stop ${i + 1} has no line: "${l}"`, "invalid_params", 'Write each stop as "path:line note"');
                return { path: parsed.path, line: parsed.line!, ...(parsed.endLine ? { endLine: parsed.endLine } : {}), note: note.join(" ") || `${i + 1}/${lines.length}`, label: `${i + 1}/${lines.length}` };
              });
              const instance = await target(options.instance, ctx.threadId);
              const result = await service.tour(instance, { title: options.title ?? "Tour", items, start: 0, interrupt: options.now ? "always" : "whenIdle" });
              const first = `${items[0]!.path}:${items[0]!.line}`;
              return {
                exitCode: 0,
                stdout: result.deferred
                  ? `Tour with ${result.count} stops set. Deferred: the user is busy; Helix shows "bb wants to show ${first} (:bb-go)". They continue with :bb-next.`
                  : `Tour with ${result.count} stops; the user is at stop 1, ${first}. They continue with :bb-next.`,
              };
            });
          },
        }),
        reload: cliCommand({
          summary: "Reload Helix buffers that changed on disk (unsaved buffers are skipped unless --force)",
          positionals: [{ name: "paths", description: "Only these files (default: every open buffer)", variadic: true }],
          options: { instance: instanceOption, force: { type: "boolean", description: "Also reload buffers with unsaved changes, discarding them" } },
          async run({ positionals, options }, ctx) {
            return guard(async () => {
              const instance = await target(options.instance, ctx.threadId);
              const paths = (positionals.paths ?? []) as string[];
              const result = await service.reload(instance, { paths, force: Boolean(options.force) });
              const roots = rootsOf(instance);
              const list = (label: string, items: string[]) => (items.length ? [`${label} (${items.length}): ${items.slice(0, 20).map((p) => displayPath(p, roots)).join(", ")}${items.length > 20 ? ", ..." : ""}`] : []);
              const lines = [...list("reloaded", result.reloaded), ...list("not reloaded, unsaved changes", result.skippedModified), ...list("missing on disk", result.missing), `unchanged: ${result.unchanged.length}`];
              return { exitCode: 0, stdout: lines.join("\n") };
            });
          },
        }),
        selection: cliCommand({
          summary: "What the user has selected (or the cursor line) in the focused pane, with the text",
          options: { instance: instanceOption, brief: { type: "boolean", description: "Positions only, no text" } },
          async run({ options }, ctx) {
            return guard(async () => {
              const instance = await target(options.instance, ctx.threadId);
              return { exitCode: 0, stdout: selectionText(await service.selection(instance), instance, !options.brief) };
            });
          },
        }),
        diagnostics: cliCommand({
          summary: "Diagnostics Helix holds, errors first (one file or the whole workspace)",
          positionals: [{ name: "path", description: "Only this file" }],
          options: {
            instance: instanceOption,
            severity: { type: "enum", values: ["error", "warning", "info", "hint"], description: "Minimum severity (default hint)" },
            limit: { type: "integer", min: 1, max: 500, description: "At most this many (default 50)" },
            offset: { type: "integer", min: 0, max: 100000, description: "Skip this many" },
          },
          async run({ positionals, options }, ctx) {
            return guard(async () => {
              const instance = await target(options.instance, ctx.threadId);
              const result = await service.diagnostics(instance, {
                ...(positionals.path ? { path: positionals.path } : {}),
                ...(options.severity ? { minSeverity: options.severity as "error" } : {}),
                ...(options.limit !== undefined ? { limit: options.limit } : {}),
                ...(options.offset !== undefined ? { offset: options.offset } : {}),
              });
              return { exitCode: 0, stdout: diagnosticsText(result.items, result.total, rootsOf(instance)) };
            });
          },
        }),
        query: cliCommand({
          summary: `Ask Helix's language server: ${QUERY_KINDS.join(", ")}`,
          positionals: [
            { name: "kind", description: QUERY_KINDS.join(" | "), required: true },
            { name: "location", description: "path:line:col of the symbol (path alone for documentSymbols)" },
          ],
          options: {
            instance: instanceOption,
            query: { type: "string", description: "Search text for workspaceSymbols" },
            "new-name": { type: "string", description: "New name for renamePreview" },
            limit: { type: "integer", min: 1, max: 500, description: "At most this many results (default 100)" },
            timeout: { type: "integer", min: 1, max: 60, description: "Seconds to wait for the language server (default 10)" },
          },
          async run({ positionals, options }, ctx) {
            return guard(async () => {
              const kind = positionals.kind as QueryKind;
              if (!(QUERY_KINDS as readonly string[]).includes(kind)) fail(`unknown query kind "${kind}"`, "invalid_kind", `One of: ${QUERY_KINDS.join(", ")}`);
              const instance = await target(options.instance, ctx.threadId);
              const location = positionals.location ? parseLocation(positionals.location) : null;
              const result = await service.query(instance, {
                kind,
                ...(location?.path ? { path: location.path } : {}),
                ...(location?.line !== undefined ? { line: location.line, col: location.col ?? 1 } : {}),
                ...(options.query !== undefined ? { query: options.query } : {}),
                ...(options["new-name"] !== undefined ? { newName: options["new-name"] } : {}),
                ...(options.limit !== undefined ? { limit: options.limit } : {}),
                ...(options.timeout !== undefined ? { timeoutMs: options.timeout * 1000 } : {}),
              });
              return { exitCode: 0, stdout: queryText(kind, result, rootsOf(instance)) };
            });
          },
        }),
        panes: cliCommand({
          summary: "Helix's panes and what each shows; --focus or --close one",
          options: {
            instance: instanceOption,
            focus: { type: "integer", min: 1, max: 100000, description: "Focus this pane" },
            close: { type: "integer", min: 1, max: 100000, description: "Close this pane (not its buffer)" },
          },
          async run({ options }, ctx) {
            return guard(async () => {
              const instance = await target(options.instance, ctx.threadId);
              if (options.focus !== undefined) await service.focusPane(instance, options.focus, "always");
              if (options.close !== undefined && (await service.closePane(instance, options.close)).deferred) return { exitCode: 0, stdout: "Deferred: the user is busy; Helix shows :bb-go." };
              const { views, layout } = await service.panes(instance);
              return { exitCode: 0, stdout: panesText(views, layout, rootsOf(instance)) };
            });
          },
        }),
        command: cliCommand({
          summary: "Run a Helix command: a typed command line, --static <name>, or --keys <keys>, under Helix's command policy",
          positionals: [{ name: "line", description: "A typed command without the colon, e.g. vsplit src/main.go", variadic: true }],
          options: {
            instance: instanceOption,
            static: { type: "string", description: "A named command from Helix's key maps, e.g. goto_definition" },
            count: { type: "integer", min: 1, max: 10000, description: "Count for --static" },
            keys: { type: "string", description: "Keys in Helix notation, e.g. <space>f" },
          },
          async run({ positionals, options }, ctx) {
            return guard(async () => {
              const typed = ((positionals.line ?? []) as string[]).join(" ").trim();
              const given = [typed || undefined, options.static, options.keys].filter(Boolean);
              if (given.length !== 1) fail("pass exactly one of a command line, --static or --keys", "invalid_command");
              const instance = await target(options.instance, ctx.threadId);
              const result = await service.command(instance, {
                ...(typed ? { typed } : {}),
                ...(options.static ? { static: options.static } : {}),
                ...(options.count !== undefined ? { count: options.count } : {}),
                ...(options.keys ? { keys: options.keys } : {}),
                interrupt: "always",
              });
              return { exitCode: result.status?.severity === "error" ? 1 : 0, stdout: commandText(result) };
            });
          },
        }),
        bind: cliCommand({
          summary: "Bind a Helix to a thread (default: the calling thread)",
          options: { instance: instanceOption, thread: { type: "string", description: "Thread id (default: the calling thread)" } },
          async run({ options }, ctx) {
            return guard(async () => {
              const threadId = options.thread ?? ctx.threadId;
              if (!threadId) fail("which thread? pass --thread", "missing_thread", "bb hx bind --instance <pid> --thread <thr_...>");
              const instance = await target(options.instance, undefined);
              const bound = await service.bridge.bind(instance.key, threadId);
              return { exitCode: 0, stdout: instanceLine(bound, await titleOf(bound)) };
            });
          },
        }),
        unbind: cliCommand({
          summary: "Remove an explicit binding (the instance falls back to its terminal's thread, or its workspace)",
          options: { instance: instanceOption },
          async run({ options }, ctx) {
            return guard(async () => {
              const instance = await target(options.instance, ctx.threadId);
              const { removed, instance: after } = await service.bridge.unbind(instance.key);
              return { exitCode: 0, stdout: `${removed ? "Unbound." : "It had no explicit binding."}\n${instanceLine(after, await titleOf(after))}` };
            });
          },
        }),
        "perf-mode": cliCommand({
          summary: "Diagnostics for one Helix: normal, quiet (its events reach the host but nothing goes on to bb) or off (no event subscriptions); for latency A/B runs",
          positionals: [{ name: "mode", description: "normal | quiet | off", required: true }],
          options: { instance: { ...instanceOption, description: "Helix instance (required): its key (host:pid), id or pid" } },
          async run({ positionals, options }) {
            return guard(async () => {
              const mode = positionals.mode;
              if (mode !== "normal" && mode !== "quiet" && mode !== "off") fail(`unknown mode "${mode}"`, "invalid_mode", "One of: normal, quiet, off");
              if (!options.instance) fail("pass --instance", "instance_required", "perf-mode never picks an instance for you");
              const instance = await target(options.instance, undefined);
              const found = await service.perfMode(instance.hostId, instance.summary.id, mode);
              return { exitCode: found ? 0 : 1, stdout: found ? `${instance.key}: ${mode}` : `${instance.key} is not connected` };
            });
          },
        }),
        doctor: cliCommand({
          summary: "What is missing on this machine and how to fix it: the hxb binary, protocol, bridge directory, gopls, goimports, the editor font",
          options: { machine: { type: "string", description: "Machine (host) id to check; default this bb's own machine", aliases: ["host"] } },
          async run({ options }) {
            return guard(async () => {
              const ghostty = await service.ghostty(options.machine ?? null).catch(() => null);
              const font = (await service.fontSetting()) || ghostty?.fontFamily || null;
              const result = await service.doctor(options.machine ?? null, font);
              const mark = { ok: "ok  ", warn: "warn", error: "FAIL" } as const;
              const lines = result.checks.map((c) => `${mark[c.level]}  ${c.label}: ${c.detail}${c.fix ? `\n      fix: ${c.fix}` : ""}`);
              const failed = result.checks.some((c) => c.level === "error");
              lines.unshift(`Machine ${result.hostId}`);
              lines.push(...(hooks.notes?.() ?? []));
              return { exitCode: failed ? 1 : 0, stdout: lines.join("\n") };
            });
          },
        }),
      },
    }),
  );
}
