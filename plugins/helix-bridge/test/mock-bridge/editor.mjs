// The mock bridge's pretend editor: buffers, panes, selections, modes,
// locations, diagnostics and a toy language server over files on disk.
// Plain data and pure-ish operations; mock.mjs puts the protocol on top.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

export class BridgeError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  notFound: 1001,
  versionMismatch: 1002,
  bufferModified: 1003,
  noLanguageServer: 1004,
  timeout: 1005,
  tooLarge: 1006,
  unsupported: 1007,
  cancelled: 1008,
};

const LANGUAGES = { ".go": "go", ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript", ".rs": "rust", ".py": "python", ".md": "markdown", ".json": "json", ".toml": "toml" };
const languageOf = (path) => (path ? LANGUAGES[extname(path)] ?? "text" : "text");
const lines = (text) => text.split("\n");
const SKIP = new Set(["node_modules", ".git", "dist", "target"]);

/**
 * What the "safe" policy refuses, after bb-bridge/COMMAND_POLICY.md (a
 * sample of each family, with Helix's aliases), and why.
 */
const SHELL = new Set(["sh", "run-shell-command", "pipe", "pipe-to", "insert-output", "append-output", "shell_pipe", "shell_pipe_to", "shell_insert_output", "shell_append_output", "shell_keep_pipe"]);
const DISCARD = new Set(["quit!", "q!", "quit-all!", "qa!", "buffer-close!", "bc!", "buffer-close-all!", "bca!", "buffer-close-others!", "bco!", "cquit!", "cq!"]);
const OVERWRITE = new Set(["write!", "w!", "write-quit!", "wq!", "x!", "write-all!", "wa!", "write-quit-all!", "wqa!", "xa!", "write-buffer-close!", "wbc!"]);
const CONFIG = new Set(["config-reload", "workspace-trust", "workspace-untrust", "workspace-exclude", "lsp-workspace-command", "debug-start", "dbg", "debug-remote", "dbg-tcp", "debug-eval", "suspend"]);
const IN_USERS_NAME = new Set(["bb-send", "bb-send!", "bb-ask", "bb-comment", "bb-comments-send"]);
const GUARDED_OPTIONS = new Set(["shell", "clipboard-provider", "terminal", "workspace-trust", "bridge"]);
const STATIC_REFUSED = new Map([["command_palette", "opens the command palette"], ["suspend", "suspends Helix"]]);
/** Static commands that wait for the next key: `keys` only. */
const NEXT_KEY = new Set(["find_next_char", "find_till_char", "find_prev_char", "till_prev_char", "replace", "select_register", "insert_register", "surround_add", "surround_replace", "surround_delete", "select_textobject_around", "select_textobject_inner"]);

function refusalOf(name, args, line, doc) {
  if (SHELL.has(name) || name.startsWith("!") || name === "|") return "runs a shell command";
  if (/%sh\{/u.test(line)) return "contains a %sh{…} expansion, which runs a shell command";
  if (DISCARD.has(name)) return "discards unsaved changes";
  if (OVERWRITE.has(name)) return "overwrites a file that changed on disk since Helix read it";
  if ((name === "reload!" || name === "rl!" || name === "reload" || name === "rl") && doc.modified) return "discards unsaved changes";
  if (CONFIG.has(name)) return "reloads configuration from files an agent can write, which can name programs to run";
  if (IN_USERS_NAME.has(name)) return "sends a message to bb in the user's name";
  if ((name === "set" || name === "set-option" || name === "toggle" || name === "toggle-option") && GUARDED_OPTIONS.has((args[0] ?? "").split(".")[0])) return `sets ${args[0]}, which can run programs`;
  return null;
}

export class Editor {
  constructor({ workspaceRoot, cwd, open = [] }) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.cwd = resolve(cwd ?? workspaceRoot);
    this.mode = "normal";
    this.docs = new Map(); // docId -> { docId, path, languageId, version, modified, text, diskText }
    this.nextDocId = 1;
    this.nextViewId = 1;
    this.views = new Map(); // viewId -> { viewId, docId, selections, primary, firstLine }
    this.layout = null;
    this.focusedView = null;
    this.lists = new Map(); // name -> { title, items, index }
    this.activeList = null;
    this.pendingJump = null;
    this.busyUntil = 0;
    /** What the pretend user left open: "prompt", "picker" or null; a half-typed key sequence. */
    this.overlay = null;
    this.pendingKeys = null;
    this.diagnostics = new Map(); // path -> [{ range, severity, message, source }]
    this.annotations = new Map(); // namespace\0path -> items
    this.reveals = []; // { paths, follow, at } from editor/reload and editor/reveal
    this.status = null;
    this.lspRunning = true;
    this.listeners = new Set();
    const scratch = this.addDoc(null, "");
    this.addView(scratch.docId);
    for (const path of open) this.open({ path, focus: true, interrupt: "always" });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method, params) {
    for (const listener of this.listeners) listener(method, params);
  }

  // ----- paths and documents ------------------------------------------------

  abs(path) {
    if (typeof path !== "string" || path.length === 0) throw new BridgeError(ERR.invalidParams, "path is required", { field: "path" });
    return isAbsolute(path) ? resolve(path) : resolve(this.workspaceRoot, path);
  }

  docByPath(path) {
    for (const doc of this.docs.values()) if (doc.path === path) return doc;
    return null;
  }

  addDoc(path, text) {
    const doc = { docId: this.nextDocId++, path, languageId: languageOf(path), version: 1, modified: false, text, diskText: text };
    this.docs.set(doc.docId, doc);
    if (path) this.emit("event/documentOpened", { docId: doc.docId, path, languageId: doc.languageId });
    return doc;
  }

  loadDoc(path) {
    const existing = this.docByPath(path);
    if (existing) return existing;
    if (!existsSync(path) || !statSync(path).isFile()) throw new BridgeError(ERR.notFound, `${path} does not exist`, { path });
    return this.addDoc(path, readFileSync(path, "utf8"));
  }

  docMeta(doc) {
    return { docId: doc.docId, path: doc.path, languageId: doc.languageId, version: doc.version, modified: doc.modified };
  }

  // ----- views ---------------------------------------------------------------

  addView(docId, { split = "none" } = {}) {
    const view = { viewId: this.nextViewId++, docId, selections: [{ start: { line: 1, col: 1 }, end: { line: 1, col: 1 } }], primary: 0, firstLine: 1 };
    this.views.set(view.viewId, view);
    if (!this.layout) this.layout = { viewId: view.viewId };
    else if (split !== "none") this.layout = { split, children: [this.layout, { viewId: view.viewId }] };
    this.focusedView = view.viewId;
    return view;
  }

  focused() {
    return this.views.get(this.focusedView);
  }

  focusedDoc() {
    return this.docs.get(this.focused().docId);
  }

  setFocus(viewId) {
    const before = this.focusedDoc();
    this.focusedView = viewId;
    const after = this.focusedDoc();
    if (before !== after) this.emit("event/focus", { docId: after.docId, path: after.path });
    this.emitSelection();
  }

  emitSelection() {
    const view = this.focused();
    const doc = this.docs.get(view.docId);
    this.emit("event/selection", { path: doc.path, docId: doc.docId, version: doc.version, primary: view.primary, ranges: view.selections });
  }

  // ----- user simulation (control socket) -------------------------------------

  /** The user pressed a key now; jumps defer for 1500 ms. */
  touch() {
    this.busyUntil = Date.now() + 1500;
  }

  /** Busy: insert mode, a key in the last 1500 ms, a half-typed sequence, or a prompt or picker open. */
  isBusy() {
    return this.mode === "insert" || Date.now() < this.busyUntil || this.pendingKeys !== null || this.overlay === "prompt" || this.overlay === "picker";
  }

  userSelect({ path, line, col = 1, endLine, endCol }) {
    if (path) {
      const doc = this.loadDoc(this.abs(path));
      const view = this.focused();
      if (view.docId !== doc.docId) {
        view.docId = doc.docId;
        this.emit("event/focus", { docId: doc.docId, path: doc.path });
      }
    }
    const view = this.focused();
    const start = { line, col };
    const end = endLine ? (endCol ? { line: endLine, col: endCol } : { line: endLine + 1, col: 1 }) : start;
    view.selections = [{ start, end }];
    view.primary = 0;
    view.firstLine = Math.max(1, line - 10);
    this.emitSelection();
  }

  userEdit(path) {
    const doc = path ? this.loadDoc(this.abs(path)) : this.focusedDoc();
    doc.text += "\n// edited in the mock editor";
    doc.version += 1;
    doc.modified = true;
    this.emit("event/documentChanged", { docId: doc.docId, path: doc.path, version: doc.version, modified: true });
  }

  userSave(path) {
    const doc = path ? this.loadDoc(this.abs(path)) : this.focusedDoc();
    doc.modified = false;
    doc.diskText = doc.text;
    this.emit("event/documentSaved", { docId: doc.docId, path: doc.path, version: doc.version });
  }

  setMode(mode) {
    this.mode = mode;
    this.emit("event/mode", { mode });
  }

  setDiagnostics(path, counts) {
    const abs = this.abs(path);
    const items = [];
    const severities = [["error", counts.errors ?? 0], ["warning", counts.warnings ?? 0], ["info", counts.infos ?? 0], ["hint", counts.hints ?? 0]];
    let line = 1;
    for (const [severity, n] of severities)
      for (let i = 0; i < n; i += 1) items.push({ path: abs, range: { start: { line, col: 1 }, end: { line, col: 5 } }, severity, message: `${severity} ${i + 1} from the mock`, source: "mock-lsp", code: `M${line}` }), (line += 1);
    this.diagnostics.set(abs, items);
    this.emit("event/diagnostics", { path: abs, errors: counts.errors ?? 0, warnings: counts.warnings ?? 0, infos: counts.infos ?? 0, hints: counts.hints ?? 0 });
  }

  /** Builds the event/send params a :bb-* command would emit. */
  sendEvent({ kind = "send", note = "", sendNow }) {
    const view = this.focused();
    const doc = this.docs.get(view.docId);
    const ranges = kind === "flush" ? [] : view.selections.map((range) => ({ ...range, text: this.rangeText(doc, range, true) }));
    return { kind, note, path: doc.path, docId: doc.docId, languageId: doc.languageId, version: doc.version, modified: doc.modified, ranges, truncated: false, sendNow: sendNow ?? (kind === "ask" || kind === "flush") };
  }

  rangeText(doc, { start, end }, wholeLineForCursor = false) {
    const all = lines(doc.text);
    if (wholeLineForCursor && start.line === end.line && start.col === end.col) return all[start.line - 1] ?? "";
    const out = [];
    for (let l = start.line; l <= Math.min(end.line, all.length); l += 1) {
      const text = all[l - 1] ?? "";
      const from = l === start.line ? start.col - 1 : 0;
      const to = l === end.line ? end.col - 1 : text.length + 1;
      out.push(text.slice(from, to));
    }
    return out.join("\n");
  }

  // ----- protocol methods ---------------------------------------------------

  state() {
    const view = this.focused();
    const doc = this.docs.get(view.docId);
    return {
      mode: this.mode,
      focused: { ...this.docMeta(doc), selections: view.selections, primary: view.primary, visible: { firstLine: view.firstLine, lastLine: view.firstLine + 40 } },
      documents: [...this.docs.values()].map((d) => this.docMeta(d)),
    };
  }

  /** Runs `move` now or stores it as the pending jump, per `interrupt`. */
  maybeDefer(interrupt, label, move, verbatim = false) {
    if ((interrupt ?? "whenIdle") === "whenIdle" && this.isBusy()) {
      this.pendingJump = move;
      this.status = { message: `bb wants to ${verbatim || label.startsWith("close ") ? label : `show ${label}`} (:bb-go)`, severity: "info" };
      return { deferred: true };
    }
    return { deferred: false, ...move() };
  }

  open({ path, line, col, endLine, endCol, split = "none", viewId, focus = true, interrupt, note }) {
    const abs = this.abs(path);
    const doc = this.loadDoc(abs);
    if (!focus) return { docId: doc.docId, path: abs, version: doc.version, viewId: null, deferred: false };
    const label = `${relative(this.workspaceRoot, abs)}${line ? `:${line}` : ""}`;
    const result = this.maybeDefer(interrupt, label, () => {
      let view;
      if (viewId !== undefined) {
        view = this.views.get(viewId);
        if (!view) throw new BridgeError(ERR.notFound, `no view ${viewId}`, { viewId });
        view.docId = doc.docId;
      } else if (split !== "none") view = this.addView(doc.docId, { split });
      else {
        view = this.focused();
        view.docId = doc.docId;
      }
      this.setFocus(view.viewId);
      if (line) {
        const start = { line, col: col ?? 1 };
        // endLine without endCol selects through the end of endLine.
        view.selections = [{ start, end: endLine ? (endCol ? { line: endLine, col: endCol } : { line: endLine + 1, col: 1 }) : start }];
        view.firstLine = Math.max(1, line - 20);
        this.emitSelection();
      }
      if (note) this.status = { message: note, severity: "info" };
      return { viewId: view.viewId };
    });
    return { docId: doc.docId, path: abs, version: doc.version, viewId: result.viewId ?? null, deferred: result.deferred };
  }

  text({ path, docId, range }) {
    let doc = docId !== undefined ? this.docs.get(docId) : this.docByPath(this.abs(path));
    if (!doc && docId !== undefined) throw new BridgeError(ERR.notFound, `no document ${docId}`);
    if (!doc) {
      const abs = this.abs(path);
      if (!existsSync(abs)) throw new BridgeError(ERR.notFound, `${abs} does not exist`, { path: abs });
      const text = readFileSync(abs, "utf8");
      return { path: abs, version: null, modified: false, text: range ? this.rangeText({ text }, range) : text, truncated: false };
    }
    const full = range ? this.rangeText(doc, range) : doc.text;
    const truncated = full.length > 1024 * 1024;
    return { path: doc.path, version: doc.version, modified: doc.modified, text: truncated ? full.slice(0, 1024 * 1024) : full, truncated };
  }

  selection() {
    const view = this.focused();
    const doc = this.docs.get(view.docId);
    const cursorsOnly = view.selections.every((r) => r.start.line === r.end.line && r.start.col === r.end.col);
    return { path: doc.path, docId: doc.docId, languageId: doc.languageId, version: doc.version, modified: doc.modified, primary: view.primary, ranges: view.selections.map((r) => ({ ...r, text: this.rangeText(doc, r, cursorsOnly) })), truncated: false };
  }

  reload({ paths, force = false, reveal = false, follow = false, interrupt } = {}) {
    if (interrupt !== undefined && interrupt !== "whenIdle" && interrupt !== "always") throw new BridgeError(ERR.invalidParams, "interrupt must be \"whenIdle\" or \"always\"", { field: "interrupt" });
    const wanted = paths ? new Set(paths.map((p) => this.abs(p))) : null;
    const out = { reloaded: [], unchanged: [], skippedModified: [], missing: [] };
    for (const doc of this.docs.values()) {
      if (!doc.path || (wanted && !wanted.has(doc.path))) continue;
      if (!existsSync(doc.path)) {
        out.missing.push(doc.path);
        continue;
      }
      const disk = readFileSync(doc.path, "utf8");
      if (disk === doc.diskText) out.unchanged.push(doc.path);
      else if (doc.modified && !force) out.skippedModified.push(doc.path);
      else {
        this.applyDisk(doc, disk, "request");
        out.reloaded.push(doc.path);
      }
    }
    if (wanted) for (const p of wanted) if (!this.docByPath(p) && !existsSync(p)) out.missing.push(p);
    // With reveal, the changed text would animate; with follow, the view moves
    // to the first reloaded buffer (deferred while the user types).
    if (reveal && out.reloaded.length > 0) this.reveals.push({ paths: [...out.reloaded], follow, at: Date.now() });
    if (follow && out.reloaded.length > 0) {
      const first = out.reloaded[0];
      out.deferred = this.open({ path: first, line: 1, interrupt }).deferred;
    }
    return out;
  }

  /** Take the file's text from disk and say what changed (`event/reloaded`). */
  applyDisk(doc, disk, origin) {
    const before = lines(doc.text);
    const after = lines(disk);
    let first = 0;
    while (first < before.length && first < after.length && before[first] === after[first]) first += 1;
    let tailB = before.length - 1;
    let tailA = after.length - 1;
    while (tailB >= first && tailA >= first && before[tailB] === after[tailA]) {
      tailB -= 1;
      tailA -= 1;
    }
    doc.text = disk;
    doc.diskText = disk;
    doc.modified = false;
    doc.version += 1;
    this.emit("event/documentChanged", { docId: doc.docId, path: doc.path, version: doc.version, modified: false });
    const ranges = tailA >= first ? [{ start: { line: first + 1, col: 1 }, end: { line: tailA + 2, col: 1 } }] : [];
    this.emit("event/reloaded", { docId: doc.docId, path: doc.path, version: doc.version, ranges, removed: Math.max(0, tailB - first + 1), origin });
  }

  /** Capability `watch`: what Helix's own watcher does when open files change on disk. */
  watchTick() {
    const reloaded = [];
    for (const doc of this.docs.values()) {
      if (!doc.path || !existsSync(doc.path)) continue;
      const disk = readFileSync(doc.path, "utf8");
      if (disk === doc.diskText) continue;
      if (doc.modified) {
        this.emit("event/externalChange", { path: doc.path, modified: true });
        continue;
      }
      this.applyDisk(doc, disk, "watch");
      reloaded.push(doc.path);
    }
    return reloaded;
  }

  applyEdits({ path, version, edits, save = false }) {
    if (!Array.isArray(edits)) throw new BridgeError(ERR.invalidParams, "edits must be an array", { field: "edits" });
    const doc = this.loadDoc(this.abs(path));
    if (version !== undefined && version !== doc.version) throw new BridgeError(ERR.versionMismatch, "the buffer changed", { version: doc.version });
    const all = lines(doc.text);
    const offset = ({ line, col }) => all.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + (col - 1);
    const sorted = edits.map((e) => ({ from: offset(e.range.start), to: offset(e.range.end), text: e.newText })).sort((a, b) => b.from - a.from);
    for (let i = 1; i < sorted.length; i += 1) if (sorted[i].to > sorted[i - 1].from) throw new BridgeError(ERR.invalidParams, "edits overlap", { field: "edits" });
    let text = doc.text;
    for (const e of sorted) text = text.slice(0, e.from) + e.text + text.slice(e.to);
    doc.text = text;
    doc.version += 1;
    doc.modified = !save;
    if (save) doc.diskText = text;
    this.emit("event/documentChanged", { docId: doc.docId, path: doc.path, version: doc.version, modified: doc.modified });
    return { path: doc.path, version: doc.version, modified: doc.modified };
  }

  setLocations({ list, title, items, activate = true, goto, interrupt }) {
    if (typeof list !== "string" || !Array.isArray(items)) throw new BridgeError(ERR.invalidParams, "list and items are required", { field: typeof list !== "string" ? "list" : "items" });
    if (items.length > 2000) throw new BridgeError(ERR.invalidParams, "at most 2000 items", { field: "items" });
    if (goto !== undefined && (!Number.isInteger(goto) || goto < 0 || goto >= items.length)) throw new BridgeError(ERR.invalidParams, "goto is past the end of items", { field: "goto" });
    const normalized = items.map((item) => ({ ...item, path: this.abs(item.path) }));
    this.lists.set(list, { title: title ?? list, items: normalized, index: -1 });
    if (activate) this.activeList = list;
    let deferred = false;
    if (goto !== undefined && normalized[goto]) {
      const item = normalized[goto];
      deferred = this.open({ path: item.path, line: item.line, col: item.col, endLine: item.endLine, interrupt, note: item.note }).deferred;
      this.lists.get(list).index = goto;
    }
    return { count: normalized.length, deferred };
  }

  clearLocations({ list } = {}) {
    if (list) this.lists.delete(list);
    else this.lists.clear();
    if (!list || this.activeList === list) this.activeList = null;
    return {};
  }

  viewList() {
    return {
      views: [...this.views.values()].map((v) => {
        const doc = this.docs.get(v.docId);
        return { viewId: v.viewId, docId: v.docId, path: doc.path, focused: v.viewId === this.focusedView, area: { x: 0, y: 0, width: 120, height: 40 }, firstLine: v.firstLine, lastLine: v.firstLine + 39 };
      }),
      layout: this.layout,
    };
  }

  viewFocus({ viewId, interrupt }) {
    if (!this.views.has(viewId)) throw new BridgeError(ERR.notFound, `no view ${viewId}`);
    const r = this.maybeDefer(interrupt, `pane ${viewId}`, () => (this.setFocus(viewId), {}));
    return { deferred: r.deferred };
  }

  /** Closing the focused pane moves the user's focus, so it honours `interrupt`; any other pane closes at once. */
  viewClose({ viewId, interrupt }) {
    if (!this.views.has(viewId)) throw new BridgeError(ERR.notFound, `no view ${viewId}`);
    if (this.views.size === 1) throw new BridgeError(ERR.unsupported, "cannot close the last pane", { reason: "last pane" });
    const close = () => {
      this.views.delete(viewId);
      const prune = (node) => {
        if (node.viewId !== undefined) return node.viewId === viewId ? null : node;
        const children = node.children.map(prune).filter(Boolean);
        return children.length === 1 ? children[0] : { ...node, children };
      };
      this.layout = prune(this.layout);
      if (this.focusedView === viewId) this.setFocus(this.views.keys().next().value);
      return {};
    };
    if (viewId !== this.focusedView) return { deferred: false, ...close() };
    const path = this.docs.get(this.views.get(viewId).docId).path;
    return { deferred: this.maybeDefer(interrupt, `close the pane showing ${path ? relative(this.cwd, path) : "[scratch]"}`, close).deferred };
  }

  select({ viewId, ranges, primary = 0, interrupt }) {
    const view = viewId !== undefined ? this.views.get(viewId) : this.focused();
    if (!view) throw new BridgeError(ERR.notFound, `no view ${viewId}`);
    if (!Array.isArray(ranges) || ranges.length === 0) throw new BridgeError(ERR.invalidParams, "ranges is required", { field: "ranges" });
    if (!Number.isInteger(primary) || primary < 0 || primary >= ranges.length) throw new BridgeError(ERR.invalidParams, "primary must index into ranges", { field: "primary" });
    const r = this.maybeDefer(interrupt, `line ${ranges[0].start.line}`, () => {
      view.selections = ranges;
      view.primary = primary;
      view.firstLine = Math.max(1, ranges[primary].start.line - 20);
      if (view.viewId === this.focusedView) this.emitSelection();
      return {};
    });
    return { version: this.docs.get(view.docId).version, deferred: r.deferred };
  }

  command(params, policy) {
    const given = ["typed", "static", "keys"].filter((k) => params[k] !== undefined);
    if (given.length !== 1) throw new BridgeError(ERR.invalidParams, "exactly one of typed, static, keys", { field: "typed" });
    if (policy === "none") throw new BridgeError(ERR.unsupported, "editor/command is disabled", { reason: "the command policy is none" });
    // Worded as the fork words it: "`sh` is refused by the command policy: it runs a shell command".
    const refuse = (reason, data = {}) => {
      throw new BridgeError(ERR.unsupported, `\`${data.command ?? "this"}\` is refused by the command policy: it ${reason}`, { reason, ...data });
    };
    if (params.typed !== undefined) {
      const line = String(params.typed).trim().replace(/^:/u, "");
      if (line === "") throw new BridgeError(ERR.invalidParams, "empty command line", { field: "typed" });
      const [name, ...args] = line.split(/\s+/u);
      const reason = policy === "safe" ? refusalOf(name, args, line, this.focusedDoc()) : null;
      if (reason) refuse(reason, { command: name });
      return this.maybeDeferCommand(params.interrupt, `run :${line}`, () => this.typed(name, args));
    }
    if (params.static !== undefined) {
      const name = params.static;
      if (params.count !== undefined && (!Number.isInteger(params.count) || params.count < 1)) throw new BridgeError(ERR.invalidParams, "count must be at least 1", { field: "count" });
      if (NEXT_KEY.has(name)) throw new BridgeError(ERR.unsupported, `${name} waits for the next key; send it with keys`, { reason: "waits for the next key", command: name });
      if (policy === "safe" && SHELL.has(name)) refuse("runs a shell command", { command: name });
      if (policy === "safe" && STATIC_REFUSED.has(name)) refuse(STATIC_REFUSED.get(name), { command: name });
      return this.maybeDeferCommand(params.interrupt, `run ${name}`, () => ({ status: { message: `ran ${name}${params.count ? ` x${params.count}` : ""}`, severity: "info" } }));
    }
    const keys = String(params.keys);
    if (policy === "safe") {
      const typed = /^:([^<]*)<ret>/u.exec(keys);
      if (typed) {
        const [name, ...args] = typed[1].trim().split(/\s+/u);
        const reason = refusalOf(name, args, typed[1], this.focusedDoc());
        if (reason) refuse(reason, { command: name, key: "<ret>", sent: typed[0].length - "<ret>".length });
      }
      if (/^[|!]/u.test(keys)) refuse("runs a shell command", { command: keys[0] === "|" ? "shell_pipe" : "shell_insert_output", key: keys[0], sent: 0 });
    }
    return this.maybeDeferCommand(params.interrupt, `press ${keys}`, () => {
      // Keys the bridge feeds do not make the user busy, but they can leave
      // a prompt open or a sequence half typed.
      this.pendingKeys = /(<space>|^g|^z)$/u.test(keys) ? (keys.endsWith("<space>") ? "<space>" : keys.slice(-1)) : null;
      this.overlay = /^:[^<]*$/u.test(keys) ? "prompt" : /<space>f$/u.test(keys) ? "picker" : null;
      if (/<ret>$|<esc>$/u.test(keys)) this.overlay = null;
      return { status: { message: `keys ${keys}`, severity: "info" } };
    });
  }

  maybeDeferCommand(interrupt, label, run) {
    // The deferred notice is "bb wants to <what> (:bb-go)".
    const r = this.maybeDefer(interrupt, label, run, true);
    if (r.deferred) return { deferred: true };
    return { deferred: false, mode: this.mode, ...(r.status ? { status: r.status } : {}), ...(this.overlay ? { overlay: this.overlay } : {}), ...(this.pendingKeys ? { pendingKeys: this.pendingKeys } : {}) };
  }

  typed(name, args) {
    if (name === "vsplit" || name === "vs" || name === "hsplit" || name === "hs") {
      const split = name.startsWith("v") ? "vertical" : "horizontal";
      const doc = args[0] ? this.loadDoc(this.abs(args[0])) : this.focusedDoc();
      const view = this.addView(doc.docId, { split });
      this.setFocus(view.viewId);
      return { status: { message: `split ${split}`, severity: "info" } };
    }
    if (name === "open" || name === "o" || name === "e") {
      this.open({ path: args[0], interrupt: "always" });
      return {};
    }
    if (name === "write" || name === "w") {
      this.userSave();
      return { status: { message: "written", severity: "info" } };
    }
    if (name === "bb-go") return this.go();
    return { status: { message: `:${[name, ...args].join(" ")}`, severity: "info" } };
  }

  go() {
    const jump = this.pendingJump;
    this.pendingJump = null;
    if (!jump) return { status: { message: "Nothing from bb is waiting", severity: "error" } };
    jump();
    return {};
  }

  annotate({ namespace, path, items }) {
    if (typeof namespace !== "string" || !namespace) throw new BridgeError(ERR.invalidParams, "namespace is required", { field: "namespace" });
    if (!Array.isArray(items)) throw new BridgeError(ERR.invalidParams, "items is required", { field: "items" });
    if (items.length > 500) throw new BridgeError(ERR.invalidParams, "at most 500 items per file", { field: "items" });
    for (const item of items) {
      if (!Number.isInteger(item.line) || item.line < 1) throw new BridgeError(ERR.invalidParams, "line must be a positive integer", { field: "items" });
      if (typeof item.text !== "string" || item.text.length > 2000) throw new BridgeError(ERR.invalidParams, "text must be at most 2000 characters", { field: "text" });
      if (item.kind !== undefined && !["comment", "reply", "note"].includes(item.kind)) throw new BridgeError(ERR.invalidParams, "kind must be comment, reply or note", { field: "items" });
      if (item.sign !== undefined && [...new Intl.Segmenter().segment(item.sign)].length !== 1) throw new BridgeError(ERR.invalidParams, "sign must be one grapheme", { field: "sign" });
    }
    const abs = this.abs(path);
    if (!this.docByPath(abs) && !existsSync(abs)) throw new BridgeError(ERR.notFound, `${abs} is neither open nor on disk`, { path: abs });
    const key = `${namespace}\0${abs}`;
    if (items.length === 0) this.annotations.delete(key);
    else this.annotations.set(key, items);
    return { count: items.length };
  }

  clearAnnotations({ namespace, path }) {
    if (typeof namespace !== "string" || !namespace) throw new BridgeError(ERR.invalidParams, "namespace is required", { field: "namespace" });
    const prefix = path ? `${namespace}\0${this.abs(path)}` : `${namespace}\0`;
    for (const key of [...this.annotations.keys()]) if (path ? key === prefix : key.startsWith(prefix)) this.annotations.delete(key);
    return {};
  }

  /** editor/reveal: purely visual; records what would animate. */
  reveal({ path, ranges, removed = [], durationMs = 600, follow = false, interrupt }) {
    if (!Array.isArray(ranges)) throw new BridgeError(ERR.invalidParams, "ranges is required", { field: "ranges" });
    if (durationMs < 50 || durationMs > 3000) throw new BridgeError(ERR.invalidParams, "durationMs must be 50 to 3000", { field: "durationMs" });
    const abs = this.abs(path);
    if (interrupt !== undefined && interrupt !== "whenIdle" && interrupt !== "always") throw new BridgeError(ERR.invalidParams, "interrupt must be \"whenIdle\" or \"always\"", { field: "interrupt" });
    if (!this.docByPath(abs) && !existsSync(abs)) throw new BridgeError(ERR.notFound, `${abs} is neither open nor on disk`, { path: abs });
    this.reveals.push({ paths: [abs], ranges, removed, follow, at: Date.now() });
    const deferred = follow && ranges[0] ? this.open({ path: abs, line: ranges[0].start.line, interrupt }).deferred : false;
    // Without follow a file that is not open has nothing on screen.
    return { animated: follow || this.docByPath(abs) ? ranges.length : 0, deferred };
  }

  getDiagnostics({ path, minSeverity = "hint", limit = 100, offset = 0 } = {}) {
    const rank = { error: 0, warning: 1, info: 2, hint: 3 };
    const all = [];
    for (const [p, items] of this.diagnostics) if (!path || p === this.abs(path)) all.push(...items);
    // counts cover everything in scope, before minSeverity, limit and offset.
    const counts = { errors: 0, warnings: 0, infos: 0, hints: 0 };
    for (const d of all) counts[{ error: "errors", warning: "warnings", info: "infos", hint: "hints" }[d.severity]] += 1;
    const kept = all.filter((d) => rank[d.severity] <= rank[minSeverity]).sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || a.range.start.line - b.range.start.line);
    if (limit === 0) return { counts, total: kept.length };
    const n = Math.min(500, Math.max(1, limit));
    return { items: kept.slice(offset, offset + n), total: kept.length, truncated: offset + n < kept.length, counts };
  }

  lspServers() {
    return { servers: this.lspRunning ? [{ id: 1, name: "mock-lsp", languages: ["go", "typescript", "javascript"], root: this.workspaceRoot, initialized: true, features: ["definition", "references", "hover", "documentSymbols", "workspaceSymbols", "incomingCalls", "outgoingCalls", "renamePreview", "diagnostics", "completion"], positionEncoding: "utf-8" }] : [] };
  }

  // A toy language server: words, regex symbols and grep.

  files() {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 6 || out.length > 2000) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (LANGUAGES[extname(entry.name)] && statSync(full).size < 512 * 1024) out.push(full);
      }
    };
    walk(this.workspaceRoot, 0);
    return out;
  }

  textOf(path) {
    const doc = this.docByPath(path);
    return doc ? doc.text : readFileSync(path, "utf8");
  }

  wordAt(path, { line, col }) {
    const text = lines(this.textOf(path))[line - 1] ?? "";
    const re = /[A-Za-z_][A-Za-z0-9_]*/gu;
    for (let m; (m = re.exec(text)); ) if (m.index <= col - 1 && col - 1 <= m.index + m[0].length) return m[0];
    return null;
  }

  location(path, line, col, length) {
    const preview = (lines(this.textOf(path))[line - 1] ?? "").trim().slice(0, 200);
    return { path, range: { start: { line, col }, end: { line, col: col + length } }, preview };
  }

  symbols(path) {
    const out = [];
    const re = /^\s*(?:export\s+)?(?:async\s+)?(func(?:\s+\([^)]*\))?|function|class|interface|type|const|struct|fn|def)\s+([A-Za-z_][A-Za-z0-9_]*)/u;
    const all = lines(this.textOf(path));
    all.forEach((text, i) => {
      const m = re.exec(text);
      if (m) out.push({ name: m[2], kind: m[1].startsWith("func") || m[1] === "function" || m[1] === "fn" || m[1] === "def" ? "function" : m[1], location: this.location(path, i + 1, text.indexOf(m[2]) + 1, m[2].length) });
    });
    // `extent`: the whole symbol, here up to the line before the next one.
    out.forEach((s, i) => {
      const last = i + 1 < out.length ? out[i + 1].location.range.start.line - 1 : all.length;
      s.extent = { start: { line: s.location.range.start.line, col: 1 }, end: { line: last + 1, col: 1 } };
    });
    return out;
  }

  query(params) {
    if (!this.lspRunning) throw new BridgeError(ERR.noLanguageServer, "no language server is running");
    const { kind } = params;
    const limit = Math.min(500, Math.max(1, params.limit ?? 100));
    const page = (items, key) => ({ [key]: items.slice(0, limit), total: items.length, truncated: items.length > limit });
    const needPos = () => {
      if (!params.path) throw new BridgeError(ERR.invalidParams, "path is required", { field: "path" });
      if (!params.position) throw new BridgeError(ERR.invalidParams, "position is required", { field: "position" });
      const path = this.abs(params.path);
      if (!existsSync(path)) throw new BridgeError(ERR.notFound, `${path} does not exist`);
      if (languageOf(path) === "text" || languageOf(path) === "markdown") throw new BridgeError(ERR.noLanguageServer, `no language server for ${languageOf(path)}`, { language: languageOf(path) === "text" ? null : languageOf(path), kind });
      const word = this.wordAt(path, params.position);
      return { path, word };
    };
    const definitions = (word) => this.files().flatMap((f) => this.symbols(f).filter((s) => s.name === word).map((s) => s.location));
    const references = (word) => {
      const out = [];
      for (const f of this.files()) {
        lines(this.textOf(f)).forEach((text, i) => {
          const re = new RegExp(`\\b${word}\\b`, "gu");
          for (let m; (m = re.exec(text)); ) out.push(this.location(f, i + 1, m.index + 1, word.length));
        });
      }
      return out;
    };
    switch (kind) {
      case "definition":
      case "typeDefinition":
      case "implementation": {
        const { word } = needPos();
        return page(word ? definitions(word) : [], "locations");
      }
      case "references": {
        const { word } = needPos();
        return page(word ? references(word) : [], "locations");
      }
      case "hover": {
        const { word } = needPos();
        const def = word ? definitions(word)[0] : null;
        return { markdown: def ? `\`\`\`\n${def.preview}\n\`\`\`` : "" };
      }
      case "documentSymbols": {
        if (!params.path) throw new BridgeError(ERR.invalidParams, "path is required", { field: "path" });
        const path = this.abs(params.path);
        if (!existsSync(path)) throw new BridgeError(ERR.notFound, `${path} does not exist`);
        return page(this.symbols(path), "symbols");
      }
      case "workspaceSymbols": {
        if (typeof params.query !== "string") throw new BridgeError(ERR.invalidParams, "query is required", { field: "query" });
        const q = params.query.toLowerCase();
        return page(this.files().flatMap((f) => this.symbols(f)).filter((s) => s.name.toLowerCase().includes(q)), "symbols");
      }
      case "incomingCalls":
      case "outgoingCalls": {
        const { word } = needPos();
        const refs = word ? references(word).filter((l) => !/func|function/u.test(l.preview)) : [];
        return page(refs.map((location) => ({ name: word, kind: "function", location, callSites: [location] })), "calls");
      }
      case "renamePreview": {
        const { word } = needPos();
        if (typeof params.newName !== "string") throw new BridgeError(ERR.invalidParams, "newName is required", { field: "newName" });
        const edits = word ? references(word).map((l) => ({ path: l.path, range: l.range, newText: params.newName })) : [];
        return { edits: edits.slice(0, limit), files: [...new Set(edits.map((e) => e.path))].sort(), total: edits.length, truncated: edits.length > limit };
      }
      default:
        throw new BridgeError(ERR.invalidParams, `unknown kind ${kind}`, { field: "kind" });
    }
  }
}
