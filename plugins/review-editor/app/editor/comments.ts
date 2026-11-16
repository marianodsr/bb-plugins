// Comments inside CodeMirror: commented lines get a quiet tint, the first
// line of each range gets a marker in the comment gutter, and in folded
// (narrow) layout an open comment renders in place under its last line. The
// note itself is React, portalled into the widget's element.
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet } from "@codemirror/view";
import type { Severity } from "../../server/contract";

export interface CommentMark {
  id: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  /** Outdated comments have no code to mark; they show only in the rail. */
  outdated: boolean;
  resolved: boolean;
}

export interface CommentView {
  marks: readonly CommentMark[];
  activeId: string | null;
  /** Folded layout: these ids render in place under their lines. */
  inline: readonly string[];
}

export const setCommentView = StateEffect.define<CommentView>();

const commentView = StateField.define<CommentView>({
  create: () => ({ marks: [], activeId: null, inline: [] }),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setCommentView)) return effect.value;
    return value;
  },
});

/** Where portals go: one element per inline comment, owned by CodeMirror. */
export class InlineSlots {
  private readonly slots = new Map<string, HTMLElement>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlyMap<string, HTMLElement> = new Map();

  mount(id: string, element: HTMLElement) {
    this.slots.set(id, element);
    this.emit();
  }
  unmount(id: string, element: HTMLElement) {
    if (this.slots.get(id) === element) {
      this.slots.delete(id);
      this.emit();
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  private emit() {
    this.snapshot = new Map(this.slots);
    for (const listener of this.listeners) listener();
  }
}

class InlineWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly slots: InlineSlots,
  ) {
    super();
  }
  override eq(other: InlineWidget) {
    return other.id === this.id;
  }
  override toDOM(view: EditorView) {
    const element = document.createElement("div");
    element.className = "rv-inline-slot";
    element.dataset.commentId = this.id;
    // Notes grow (replies, composer); tell CodeMirror to measure again.
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(element);
    (element as HTMLElement & { rvObserver?: ResizeObserver }).rvObserver = observer;
    this.slots.mount(this.id, element);
    return element;
  }
  override destroy(element: HTMLElement) {
    (element as HTMLElement & { rvObserver?: ResizeObserver }).rvObserver?.disconnect();
    this.slots.unmount(this.id, element);
  }
  override ignoreEvent() {
    return true;
  }
}

function lineDecorations(state: EditorState): DecorationSet {
  const { marks, activeId } = state.field(commentView);
  const doc = state.doc;
  const perLine = new Map<number, { severity: Severity; active: boolean }>();
  for (const mark of marks) {
    if (mark.outdated || mark.resolved) continue;
    const active = mark.id === activeId;
    for (let line = mark.startLine; line <= Math.min(mark.endLine, doc.lines); line += 1) {
      const current = perLine.get(line);
      if (current === undefined || (active && !current.active)) perLine.set(line, { severity: mark.severity, active });
    }
  }
  const builder = new RangeSetBuilder<Decoration>();
  for (const line of [...perLine.keys()].sort((a, b) => a - b)) {
    const { severity, active } = perLine.get(line)!;
    builder.add(
      doc.line(line).from,
      doc.line(line).from,
      Decoration.line({ class: `rv-commented rv-sev-${severity}${active ? " rv-commented-active" : ""}` }),
    );
  }
  return builder.finish();
}

function inlineDecorations(state: EditorState, slots: InlineSlots): DecorationSet {
  const { marks, inline } = state.field(commentView);
  if (inline.length === 0) return Decoration.none;
  const doc = state.doc;
  const placed = inline
    .map((id) => {
      const mark = marks.find((candidate) => candidate.id === id);
      if (mark === undefined) return null;
      const line = doc.line(Math.min(Math.max(mark.endLine, 1), doc.lines));
      return { id, at: line.to };
    })
    .filter((entry): entry is { id: string; at: number } => entry !== null)
    .sort((a, b) => a.at - b.at);
  const builder = new RangeSetBuilder<Decoration>();
  for (const { id, at } of placed) {
    builder.add(at, at, Decoration.widget({ widget: new InlineWidget(id, slots), block: true, side: 1 }));
  }
  return builder.finish();
}

class CommentMarker extends GutterMarker {
  constructor(
    readonly ids: readonly string[],
    readonly severity: Severity,
    readonly active: boolean,
  ) {
    super();
  }
  override eq(other: CommentMarker) {
    return other.ids.join() === this.ids.join() && other.severity === this.severity && other.active === this.active;
  }
  override toDOM() {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = `rv-comment-marker rv-sev-${this.severity}${this.active ? " rv-comment-marker-active" : ""}`;
    marker.dataset.commentIds = this.ids.join(",");
    marker.setAttribute("aria-label", this.ids.length === 1 ? "Show comment" : `Show ${this.ids.length} comments`);
    if (this.ids.length > 1) marker.textContent = String(this.ids.length);
    return marker;
  }
}

const SEVERITY_RANK: Record<Severity, number> = { note: 0, suggestion: 1, issue: 2, blocker: 3 };

function commentMarkers(state: EditorState) {
  const { marks, activeId } = state.field(commentView);
  const doc = state.doc;
  const byLine = new Map<number, CommentMark[]>();
  for (const mark of marks) {
    if (mark.outdated || mark.resolved || mark.startLine > doc.lines) continue;
    const list = byLine.get(mark.startLine) ?? [];
    list.push(mark);
    byLine.set(mark.startLine, list);
  }
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    const list = byLine.get(line)!;
    const severity = list.reduce<Severity>((top, mark) => (SEVERITY_RANK[mark.severity] > SEVERITY_RANK[top] ? mark.severity : top), "note");
    builder.add(
      doc.line(line).from,
      doc.line(line).from,
      new CommentMarker(list.map((mark) => mark.id), severity, list.some((mark) => mark.id === activeId)),
    );
  }
  return builder.finish();
}

export function commentLayer(options: { slots: InlineSlots; onMarker: (ids: readonly string[]) => void }): Extension {
  return [
    commentView,
    EditorView.decorations.compute([commentView], lineDecorations),
    EditorView.decorations.compute([commentView], (state) => inlineDecorations(state, options.slots)),
    gutter({
      class: "rv-comment-gutter",
      markers: (view) => commentMarkers(view.state),
      domEventHandlers: {
        mousedown(_view, _line, event) {
          const ids = (event.target as HTMLElement).closest<HTMLElement>(".rv-comment-marker")?.dataset.commentIds;
          if (ids === undefined) return false;
          event.preventDefault();
          options.onMarker(ids.split(","));
          return true;
        },
      },
    }),
  ];
}
