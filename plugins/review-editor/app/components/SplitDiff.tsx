// Side-by-side diff, read-only: the base on the left, the buffer on the right.
// Editing happens in Edit or the unified diff; this view is for reading.
import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { languageFor } from "../model/languages";
import { languageSupport } from "../editor/languages";
import { codeMirrorTheme, type CodeTheme } from "../editor/theme";

export function SplitDiff({
  original,
  content,
  path,
  theme,
  labels,
  topLine,
}: {
  original: string;
  content: string;
  path: string;
  theme: CodeTheme | null;
  labels: [string, string];
  topLine: number;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (host.current === null) return;
    const shared = [
      lineNumbers(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      languageSupport(languageFor(path)),
      ...(theme === null ? [] : [codeMirrorTheme(theme)]),
    ];
    const view = new MergeView({
      parent: host.current,
      a: { doc: original, extensions: shared },
      b: { doc: content, extensions: shared },
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    const line = view.b.state.doc.line(Math.min(Math.max(topLine, 1), view.b.state.doc.lines));
    view.b.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "start" }) });
    return () => view.destroy();
  }, [original, content, path, theme, topLine]);

  return (
    <div className="min-w-0">
      <div className="sticky top-0 z-10 grid grid-cols-2 border-b border-border/60 bg-background text-xs text-muted-foreground">
        <span className="px-3 py-1.5">{labels[0]}</span>
        <span className="border-l border-border/60 px-3 py-1.5">{labels[1]}</span>
      </div>
      <div ref={host} />
    </div>
  );
}
