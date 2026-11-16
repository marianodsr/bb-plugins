// One CodeMirror view for a file, with everything that can change behind
// compartments so switching mode, theme or base never rebuilds the editor
// (scroll position, cursor and undo history survive).
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { diff, unifiedMergeView } from "@codemirror/merge";
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, Transaction, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { languageFor } from "../model/languages";
import { changeBars, changeTracking, setBase } from "./changes";
import { commentLayer, setCommentView, type CommentView, type InlineSlots } from "./comments";
import { languageSupport } from "./languages";
import { codeMirrorTheme, type CodeTheme } from "./theme";

export type EditorMode = "edit" | "unified";

export interface EditorCallbacks {
  /** The buffer changed (debounced by the caller as needed). */
  onDocChange: () => void;
  /** Selection or focus changed; geometry for the toolbar may have moved. */
  onSelection: () => void;
  /** Layout moved (scroll, resize, folding, widgets): rail positions are stale. */
  onGeometry: () => void;
  onSave: () => void;
  onComment: () => void;
  onWalk: (direction: 1 | -1) => void;
  /** Escape with nothing else to close: leave the editor for the page keys. */
  onEscape: () => void;
  onMarker: (ids: readonly string[]) => void;
}

export interface EditorOptions {
  parent: HTMLElement;
  content: string;
  path: string;
  theme: CodeTheme | null;
  base: string | null;
  mode: EditorMode;
  slots: InlineSlots;
  callbacks: EditorCallbacks;
}

/** An annotation on transactions the editor makes itself (external reloads). */
const external = Transaction.userEvent.of("external");

function lineSeparator(content: string): Extension {
  return content.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : [];
}

export class ReviewEditor {
  readonly view: EditorView;
  private readonly themeSlot = new Compartment();
  private readonly languageSlot = new Compartment();
  private readonly modeSlot = new Compartment();
  private readonly separatorSlot = new Compartment();
  private base: string | null;
  private mode: EditorMode;
  private theme: CodeTheme | null;
  private readonly callbacks: EditorCallbacks;

  constructor(options: EditorOptions) {
    this.base = options.base;
    this.mode = options.mode;
    this.theme = options.theme;
    this.callbacks = options.callbacks;
    const cb = this.callbacks;
    this.view = new EditorView({
      parent: options.parent,
      state: EditorState.create({
        doc: options.content,
        extensions: [
          this.separatorSlot.of(lineSeparator(options.content)),
          lineNumbers(),
          foldGutter({ markerDOM: (open) => this.foldMarker(open) }),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          changeTracking,
          commentLayer({ slots: options.slots, onMarker: (ids) => cb.onMarker(ids) }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (cb.onSave(), true) },
            { key: "Mod-Alt-m", preventDefault: true, run: () => (cb.onComment(), true) },
            { key: "F8", run: () => (cb.onWalk(1), true) },
            { key: "Shift-F8", run: () => (cb.onWalk(-1), true) },
            { key: "Ctrl-g", run: gotoLine },
            ...searchKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
            { key: "Escape", run: (view) => this.escape(view) },
          ]),
          this.languageSlot.of(languageSupport(languageFor(options.path))),
          this.themeSlot.of(this.themeExtension()),
          this.modeSlot.of(this.modeExtension()),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) cb.onDocChange();
            if (update.selectionSet || update.focusChanged) cb.onSelection();
            if (update.geometryChanged || update.viewportChanged || update.heightChanged || update.docChanged) {
              cb.onGeometry();
            }
          }),
          EditorView.domEventHandlers({ scroll: () => cb.onGeometry() }),
        ],
      }),
    });
    if (this.base !== null) this.view.dispatch({ effects: setBase.of(this.base) });
  }

  private foldMarker(open: boolean) {
    const marker = document.createElement("span");
    marker.className = `rv-fold ${open ? "rv-fold-open" : "rv-fold-closed"}`;
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }

  private escape(view: EditorView): boolean {
    // Let search and the selection clear first: one level per Escape.
    if (view.state.selection.ranges.some((range) => !range.empty)) {
      view.dispatch({ selection: EditorSelection.cursor(view.state.selection.main.head) });
      return true;
    }
    this.callbacks.onEscape();
    return true;
  }

  private themeExtension(): Extension {
    return this.theme === null ? [] : codeMirrorTheme(this.theme);
  }

  private modeExtension(): Extension {
    if (this.mode === "unified" && this.base !== null) {
      return unifiedMergeView({
        original: this.base,
        gutter: true,
        highlightChanges: true,
        syntaxHighlightDeletions: true,
        mergeControls: false,
      });
    }
    return changeBars;
  }

  setTheme(theme: CodeTheme | null) {
    if (theme === this.theme) return;
    this.theme = theme;
    this.view.dispatch({ effects: this.themeSlot.reconfigure(this.themeExtension()) });
  }

  setBase(base: string | null) {
    if (base === this.base) return;
    this.base = base;
    this.view.dispatch({
      effects: [setBase.of(base), ...(this.mode === "unified" ? [this.modeSlot.reconfigure(this.modeExtension())] : [])],
    });
  }

  setMode(mode: EditorMode) {
    if (mode === this.mode) return;
    const top = this.topLine();
    this.mode = mode;
    this.view.dispatch({ effects: this.modeSlot.reconfigure(this.modeExtension()) });
    // Keep the line at the top of the viewport where it was.
    this.scrollToLine(top, "start");
  }

  setComments(comments: CommentView) {
    this.view.dispatch({ effects: setCommentView.of(comments) });
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  /**
   * Replace the buffer with new disk content, as the smallest set of changes,
   * so the cursor, selection and scroll stay with the text around them.
   */
  replaceContent(content: string) {
    const current = this.getContent();
    if (current === content) return;
    const changes = diff(current, content).map((change) => ({
      from: change.fromA,
      to: change.toA,
      insert: content.slice(change.fromB, change.toB),
    }));
    this.view.dispatch({
      changes,
      effects: this.separatorSlot.reconfigure(lineSeparator(content)),
      annotations: [external, Transaction.addToHistory.of(false)],
    });
  }

  /** Select one-based lines and bring them into view. */
  revealLines(startLine: number, endLine: number, options: { select?: boolean; cursor?: boolean; focus?: boolean } = {}) {
    const doc = this.view.state.doc;
    const start = doc.line(Math.min(Math.max(startLine, 1), doc.lines));
    const end = doc.line(Math.min(Math.max(endLine, startLine, 1), doc.lines));
    this.view.dispatch({
      ...(options.select === false
        ? options.cursor
          ? { selection: EditorSelection.cursor(start.from) }
          : {}
        : { selection: EditorSelection.range(start.from, end.to) }),
      effects: EditorView.scrollIntoView(start.from, { y: "center" }),
    });
    if (options.focus) this.view.focus();
  }

  scrollToLine(line: number, y: "start" | "center" = "center") {
    const doc = this.view.state.doc;
    const at = doc.line(Math.min(Math.max(line, 1), doc.lines));
    this.view.dispatch({ effects: EditorView.scrollIntoView(at.from, { y }) });
  }

  /** The first fully visible line, one-based. */
  topLine(): number {
    const rect = this.view.scrollDOM.getBoundingClientRect();
    const top = Math.max(rect.top, 0) - this.view.documentTop;
    const block = this.view.lineBlockAtHeight(Math.max(0, top));
    return this.view.state.doc.lineAt(block.from).number;
  }

  /** The selected one-based line range, or the cursor line. */
  selectedLines(): { startLine: number; endLine: number; empty: boolean } {
    const { from, to, empty } = this.view.state.selection.main;
    const doc = this.view.state.doc;
    const startLine = doc.lineAt(from).number;
    // A selection ending at column 0 does not include that line.
    let endLine = doc.lineAt(to).number;
    if (!empty && endLine > startLine && doc.lineAt(to).from === to) endLine -= 1;
    return { startLine, endLine, empty };
  }

  cursorLine(): number {
    return this.view.state.doc.lineAt(this.view.state.selection.main.head).number;
  }

  /** The y of a line's top relative to `element`'s top (both in layout pixels). */
  lineTop(line: number, element: HTMLElement): number {
    const doc = this.view.state.doc;
    const at = doc.line(Math.min(Math.max(line, 1), doc.lines));
    const block = this.view.lineBlockAt(at.from);
    return block.top + this.view.documentTop - element.getBoundingClientRect().top;
  }

  /** Viewport coordinates for the end of the main selection, for the toolbar. */
  selectionCoords(): { left: number; top: number; bottom: number } | null {
    const range = this.view.state.selection.main;
    if (range.empty) return null;
    const head = this.view.coordsAtPos(range.to, -1) ?? this.view.coordsAtPos(range.head);
    return head === null ? null : { left: head.left, top: head.top, bottom: head.bottom };
  }

  hasFocus(): boolean {
    return this.view.hasFocus;
  }

  focus() {
    this.view.focus();
  }

  destroy() {
    this.view.destroy();
  }
}
