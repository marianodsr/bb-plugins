// Translate BB's active code theme (a VS Code theme document from
// experimental_useCodeTheme) into a CodeMirror theme and highlight style, so
// the editor matches BB's own code blocks in every palette.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { tags as t, type Tag } from "@lezer/highlight";

export interface CodeTheme {
  type: "dark" | "light";
  fg: string;
  bg: string;
  colors: Readonly<Record<string, string>>;
  tokenColors: readonly { scope?: string | readonly string[]; settings: { foreground?: string; fontStyle?: string } }[];
}

/** Lezer tags and the TextMate scopes a VS Code theme styles them with, most specific first. */
const TAG_SCOPES: [Tag | Tag[], string[]][] = [
  [t.comment, ["comment"]],
  [[t.string, t.special(t.string)], ["string"]],
  [t.regexp, ["string.regexp", "string"]],
  [t.escape, ["constant.character.escape", "constant.character"]],
  [[t.number, t.integer, t.float], ["constant.numeric", "constant"]],
  [[t.bool, t.null, t.atom], ["constant.language", "constant"]],
  [[t.keyword, t.modifier, t.operatorKeyword], ["keyword", "storage"]],
  [t.controlKeyword, ["keyword.control", "keyword"]],
  [t.definitionKeyword, ["storage.type", "keyword"]],
  [t.moduleKeyword, ["keyword.control.import", "keyword"]],
  [t.operator, ["keyword.operator", "keyword"]],
  [[t.typeName, t.className], ["entity.name.type", "support.type", "entity.name"]],
  [t.namespace, ["entity.name.namespace", "entity.name"]],
  [[t.function(t.variableName), t.function(t.propertyName)], ["entity.name.function", "support.function"]],
  [t.definition(t.variableName), ["variable", "variable.other"]],
  [t.variableName, ["variable", "variable.other"]],
  [t.propertyName, ["variable.other.property", "meta.object-literal.key", "variable"]],
  [t.attributeName, ["entity.other.attribute-name"]],
  [t.tagName, ["entity.name.tag"]],
  [t.heading, ["markup.heading", "entity.name.section"]],
  [t.emphasis, ["markup.italic"]],
  [t.strong, ["markup.bold"]],
  [t.link, ["markup.underline.link", "string"]],
  [t.meta, ["meta", "comment"]],
  [t.invalid, ["invalid"]],
];

function scopesOf(rule: CodeTheme["tokenColors"][number]): string[] {
  if (rule.scope === undefined) return [];
  const list = typeof rule.scope === "string" ? rule.scope.split(",") : [...rule.scope];
  return list.map((scope) => scope.trim()).filter((scope) => scope !== "");
}

/** The theme setting for a scope: the rule whose selector is the longest prefix of it. */
function settingFor(theme: CodeTheme, scope: string) {
  let best: { length: number; settings: CodeTheme["tokenColors"][number]["settings"] } | null = null;
  for (const rule of theme.tokenColors) {
    for (const selector of scopesOf(rule)) {
      // Only plain selectors; descendant selectors ("a b") need a scope stack.
      if (selector.includes(" ")) continue;
      if (scope === selector || scope.startsWith(`${selector}.`)) {
        if (best === null || selector.length > best.length) best = { length: selector.length, settings: rule.settings };
      }
    }
  }
  return best?.settings ?? null;
}

export function codeMirrorTheme(theme: CodeTheme): Extension {
  const c = theme.colors;
  const view = EditorView.theme(
    {
      // The surface is bb's own; only ink and syntax come from the code theme.
      "&": { color: c["editor.foreground"] ?? theme.fg, backgroundColor: "transparent" },
      ".cm-content": { caretColor: c["editorCursor.foreground"] ?? theme.fg },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: c["editorCursor.foreground"] ?? theme.fg },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: c["editor.selectionBackground"] ?? "color-mix(in srgb, currentColor 20%, transparent)",
      },
      ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--foreground) 4%, transparent)" },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: c["editorLineNumber.foreground"] ?? "inherit",
        border: "none",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: c["editorLineNumber.activeForeground"] ?? c["editor.foreground"] ?? theme.fg,
      },
    },
    { dark: theme.type === "dark" },
  );
  const specs = TAG_SCOPES.flatMap(([tag, scopes]) => {
    for (const scope of scopes) {
      const setting = settingFor(theme, scope);
      if (setting?.foreground === undefined && setting?.fontStyle === undefined) continue;
      const style = setting.fontStyle ?? "";
      return [
        {
          tag,
          ...(setting.foreground === undefined ? {} : { color: setting.foreground }),
          ...(style.includes("italic") ? { fontStyle: "italic" } : {}),
          ...(style.includes("bold") ? { fontWeight: "bold" } : {}),
          ...(style.includes("underline") ? { textDecoration: "underline" } : {}),
        },
      ];
    }
    return [];
  });
  return [view, syntaxHighlighting(HighlightStyle.define(specs))];
}
