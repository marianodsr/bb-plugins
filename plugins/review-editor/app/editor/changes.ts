// Edit mode's change bars: a thin gutter marks added, changed and removed
// lines against the base (HEAD). Clicking a bar opens the old lines in place,
// under a small header with Restore.
import { Chunk } from "@codemirror/merge";
import { RangeSetBuilder, StateEffect, StateField, Text, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet } from "@codemirror/view";

export type ChangeKind = "added" | "modified" | "removed";

/** Replace the base document (null: no base, no bars). */
export const setBase = StateEffect.define<string | null>();
const togglePeek = StateEffect.define<number>();

interface ChangeState {
  base: Text | null;
  chunks: readonly Chunk[];
  /** fromA of every chunk whose old lines are shown. */
  peeks: ReadonlySet<number>;
}

const DIFF_CONFIG = { scanLimit: 2_000, timeout: 200 };

const changeState = StateField.define<ChangeState>({
  create: () => ({ base: null, chunks: [], peeks: new Set() }),
  update(value, tr) {
    let { base, chunks, peeks } = value;
    let rebuild = false;
    for (const effect of tr.effects) {
      if (effect.is(setBase)) {
        base = effect.value === null ? null : Text.of(effect.value.split(/\r\n?|\n/u));
        peeks = new Set();
        rebuild = true;
      } else if (effect.is(togglePeek)) {
        const next = new Set(peeks);
        if (next.has(effect.value)) next.delete(effect.value);
        else next.add(effect.value);
        peeks = next;
      }
    }
    if (base === null) return { base, chunks: [], peeks };
    if (rebuild) chunks = Chunk.build(base, tr.state.doc, DIFF_CONFIG);
    else if (tr.docChanged) {
      chunks = Chunk.updateB(chunks, base, tr.state.doc, tr.changes, DIFF_CONFIG);
      // Peeks are keyed by fromA, which edits to B never move; drop stale ones.
      const live = new Set(chunks.map((chunk) => chunk.fromA));
      peeks = new Set([...peeks].filter((key) => live.has(key)));
    }
    return { base, chunks, peeks };
  },
});

/** Classify a chunk the way the gutter draws it. */
export function chunkKind(chunk: Pick<Chunk, "fromA" | "toA" | "fromB" | "toB">): ChangeKind {
  if (chunk.fromA === chunk.toA) return "added";
  if (chunk.fromB === chunk.toB) return "removed";
  return "modified";
}

class BarMarker extends GutterMarker {
  constructor(
    readonly kind: ChangeKind,
    readonly key: number,
  ) {
    super();
  }
  override eq(other: BarMarker) {
    return other.kind === this.kind && other.key === this.key;
  }
  override toDOM() {
    const bar = document.createElement("div");
    bar.className = `rv-bar rv-bar-${this.kind}`;
    bar.dataset.chunk = String(this.key);
    bar.title = this.kind === "removed" ? "Lines removed here: show them" : "Changed since HEAD: show the old lines";
    return bar;
  }
}

function markers(state: EditorState) {
  const builder = new RangeSetBuilder<GutterMarker>();
  const { chunks } = state.field(changeState);
  const doc = state.doc;
  for (const chunk of chunks) {
    const kind = chunkKind(chunk);
    if (kind === "removed") {
      const line = doc.lineAt(Math.min(chunk.fromB, doc.length));
      builder.add(line.from, line.from, new BarMarker(kind, chunk.fromA));
      continue;
    }
    const first = doc.lineAt(chunk.fromB).number;
    const last = doc.lineAt(Math.max(chunk.fromB, Math.min(chunk.endB, doc.length))).number;
    for (let number = first; number <= last; number += 1) {
      const line = doc.line(number);
      builder.add(line.from, line.from, new BarMarker(kind, chunk.fromA));
    }
  }
  return builder.finish();
}

class PeekWidget extends WidgetType {
  constructor(
    readonly oldText: string,
    readonly key: number,
    readonly kind: ChangeKind,
  ) {
    super();
  }
  override eq(other: PeekWidget) {
    return other.oldText === this.oldText && other.key === this.key;
  }
  override toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "rv-peek";
    const head = document.createElement("div");
    head.className = "rv-peek-head";
    const label = document.createElement("span");
    const count = this.oldText === "" ? 0 : this.oldText.split("\n").length;
    label.textContent =
      this.kind === "added" ? "New since HEAD" : `${count} ${count === 1 ? "line" : "lines"} at HEAD`;
    head.append(label);
    if (this.kind !== "added") {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "rv-peek-action";
      restore.textContent = "Restore";
      restore.title = "Put the HEAD lines back";
      restore.addEventListener("mousedown", (event) => {
        event.preventDefault();
        restoreChunk(view, this.key);
      });
      head.append(restore);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "rv-peek-action";
    close.textContent = "Hide";
    close.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ effects: togglePeek.of(this.key) });
    });
    head.append(close);
    wrap.append(head);
    if (this.oldText !== "") {
      const body = document.createElement("pre");
      body.className = "rv-peek-body";
      body.textContent = this.oldText;
      wrap.append(body);
    }
    return wrap;
  }
  override ignoreEvent() {
    return false;
  }
}

function peekDecorations(state: EditorState): DecorationSet {
  const { base, chunks, peeks } = state.field(changeState);
  if (base === null || peeks.size === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const chunk of chunks) {
    if (!peeks.has(chunk.fromA)) continue;
    const kind = chunkKind(chunk);
    const oldText = kind === "added" ? "" : base.sliceString(chunk.fromA, Math.min(chunk.endA, base.length));
    const at = state.doc.lineAt(Math.min(chunk.fromB, state.doc.length)).from;
    builder.add(at, at, Decoration.widget({ widget: new PeekWidget(oldText, chunk.fromA, kind), block: true, side: -1 }));
  }
  return builder.finish();
}

const peeks = EditorView.decorations.compute([changeState], peekDecorations);

/** Put a chunk's HEAD lines back in place of the current ones. */
export function restoreChunk(view: EditorView, key: number): boolean {
  const { base, chunks } = view.state.field(changeState);
  const chunk = chunks.find((candidate) => candidate.fromA === key);
  if (base === null || chunk === undefined) return false;
  const insert = base.sliceString(chunk.fromA, Math.min(chunk.toA, base.length));
  view.dispatch({
    changes: { from: chunk.fromB, to: Math.min(chunk.toB, view.state.doc.length), insert },
    effects: togglePeek.of(key),
    userEvent: "input.restore",
  });
  return true;
}

/** Toggle the old lines of the chunk touching `line` (one-based). */
export function togglePeekAtLine(view: EditorView, line: number): boolean {
  const { chunks } = view.state.field(changeState);
  const doc = view.state.doc;
  const at = doc.line(Math.min(Math.max(line, 1), doc.lines));
  const chunk = chunks.find((candidate) => {
    const from = doc.lineAt(Math.min(candidate.fromB, doc.length)).from;
    const to = Math.max(from, Math.min(candidate.endB, doc.length));
    return at.from >= from && at.from <= to;
  });
  if (chunk === undefined) return false;
  view.dispatch({ effects: togglePeek.of(chunk.fromA) });
  return true;
}

export function changeChunks(state: EditorState): readonly Chunk[] {
  return state.field(changeState, false)?.chunks ?? [];
}

const changeGutter = gutter({
  class: "rv-change-gutter",
  markers: (view) => markers(view.state),
  domEventHandlers: {
    mousedown(view, line, event) {
      const target = event.target as HTMLElement;
      const key = target.closest<HTMLElement>(".rv-bar")?.dataset.chunk;
      if (key === undefined) return false;
      view.dispatch({ effects: togglePeek.of(Number(key)) });
      void line;
      return true;
    },
  },
});

/** The base field (always needed) and the bars and peeks (Edit mode only). */
export const changeTracking: Extension = changeState;
export const changeBars: Extension = [changeGutter, peeks];
