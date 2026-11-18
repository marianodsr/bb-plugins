// Syntax colours for the code a comment quotes. highlight.js reads the
// snippet (a few lines, out of their file, so it needs no project and no
// language server); the colours are the host's own code theme, the same
// document bb's highlighter paints from, looked up by TextMate scope.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = { bash, c, cpp, css, diff, dockerfile, go, graphql, ini, java, javascript, json, kotlin, makefile, markdown, protobuf, python, ruby, rust, sql, swift, typescript, xml, yaml };
for (const [name, grammar] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, grammar);

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  go: "go",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  // Bazel's Starlark reads as Python.
  bzl: "python",
  bazel: "python",
  star: "python",
  rs: "rust",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  mdx: "markdown",
  sql: "sql",
  proto: "protobuf",
  css: "css",
  scss: "css",
  html: "xml",
  xml: "xml",
  svg: "xml",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  rb: "ruby",
  swift: "swift",
  graphql: "graphql",
  gql: "graphql",
  diff: "diff",
  patch: "diff",
  mk: "makefile",
};
const BY_NAME: Record<string, keyof typeof LANGUAGES> = { Dockerfile: "dockerfile", Makefile: "makefile", BUILD: "python", WORKSPACE: "python" };

/** The grammar for a file, by its name; null when there is none (plain text). */
export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

/** A run of text and what it is ("keyword", "string", "title.function"), or null for plain text. */
export interface Token {
  text: string;
  kind: string | null;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };

/** highlight.js writes `hljs-title function_` for what it calls title.function. */
function kindOf(classes: string): string | null {
  const parts = classes.split(/\s+/u).filter(Boolean);
  const first = parts[0];
  if (!first?.startsWith("hljs-")) return null;
  return [first.slice(5), ...parts.slice(1).map((p) => p.replace(/_+$/u, ""))].join(".");
}

/** The code as lines of tokens. An unknown language, or code highlight.js cannot read, comes back plain. */
export function highlightLines(code: string, language: string | null): Token[][] {
  const plain = () => code.split("\n").map((line) => [{ text: line, kind: null }]);
  if (!language || !hljs.getLanguage(language)) return plain();
  let html: string;
  try {
    html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return plain();
  }
  const lines: Token[][] = [[]];
  const stack: (string | null)[] = [];
  for (const match of html.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/gu)) {
    if (match[1] !== undefined) stack.push(kindOf(match[1]));
    else if (match[2] === undefined) stack.pop();
    else {
      // The innermost span that names something (a nested `language-xml` span names nothing).
      let kind: string | null = null;
      for (let i = stack.length - 1; i >= 0 && kind === null; i--) kind = stack[i] ?? null;
      const text = match[2].replace(/&(?:amp|lt|gt|quot|#x27);/gu, (entity) => ENTITIES[entity] ?? entity);
      text.split("\n").forEach((piece, i) => {
        if (i > 0) lines.push([]);
        if (piece) lines[lines.length - 1]!.push({ text: piece, kind });
      });
    }
  }
  return lines;
}

/** The TextMate scopes a highlight.js kind stands for, most telling first. */
const SCOPES: Record<string, readonly string[]> = {
  keyword: ["keyword.control", "storage.type"],
  built_in: ["support.function", "support.type"],
  type: ["entity.name.type", "support.type", "storage.type"],
  literal: ["constant.language"],
  number: ["constant.numeric"],
  string: ["string.quoted", "string"],
  regexp: ["string.regexp"],
  symbol: ["constant.other.symbol", "constant.other"],
  "char.escape": ["constant.character.escape"],
  title: ["entity.name.function"],
  "title.function": ["entity.name.function"],
  "title.class": ["entity.name.type.class", "entity.name.class", "entity.name.type"],
  "title.class.inherited": ["entity.other.inherited-class", "entity.name.type"],
  params: ["variable.parameter"],
  comment: ["comment.line", "comment"],
  doctag: ["storage.type.class.jsdoc", "keyword.other.documentation"],
  meta: ["meta.preprocessor", "keyword.control.directive", "entity.name.function.decorator"],
  "meta.keyword": ["keyword.control"],
  "meta.string": ["string.quoted", "string"],
  attr: ["support.type.property-name", "entity.other.attribute-name", "variable.other.property"],
  attribute: ["support.type.property-name", "entity.other.attribute-name"],
  property: ["variable.other.property", "support.type.property-name"],
  variable: ["variable.other.readwrite", "variable"],
  "variable.language": ["variable.language"],
  "variable.constant": ["variable.other.constant", "constant.other"],
  operator: ["keyword.operator"],
  punctuation: ["punctuation"],
  tag: ["punctuation.definition.tag"],
  name: ["entity.name.tag"],
  "selector-tag": ["entity.name.tag"],
  "selector-class": ["entity.other.attribute-name.class", "entity.other.attribute-name"],
  "selector-id": ["entity.other.attribute-name.id", "entity.other.attribute-name"],
  section: ["markup.heading", "entity.name.section"],
  bullet: ["punctuation.definition.list", "markup.list"],
  emphasis: ["markup.italic"],
  strong: ["markup.bold"],
  code: ["markup.inline.raw", "markup.raw"],
  link: ["markup.underline.link"],
  quote: ["markup.quote"],
  addition: ["markup.inserted"],
  deletion: ["markup.deleted"],
  "template-variable": ["variable.other", "variable"],
  "template-tag": ["keyword.control"],
};

/** What a theme rule gives a token. */
export interface TokenStyle {
  color?: string;
  fontStyle?: "italic";
  fontWeight?: number;
}

/** The part of the host's code theme this reads (`experimental_useCodeTheme().theme`). */
export interface CodeTheme {
  tokenColors: readonly { scope?: string | readonly string[]; settings: { foreground?: string; fontStyle?: string } }[];
}

const styles = new WeakMap<CodeTheme, Map<string, TokenStyle | null>>();

/** The theme rule for one scope: the longest selector that is a prefix of it; later rules win ties. */
function styleOfScope(theme: CodeTheme, scope: string): TokenStyle | null {
  let best: { length: number; settings: { foreground?: string; fontStyle?: string } } | null = null;
  for (const rule of theme.tokenColors) {
    if (rule.scope === undefined) continue;
    const selectors = (typeof rule.scope === "string" ? rule.scope.split(",") : rule.scope).map((s) => s.trim().split(/\s+/u).pop() ?? "");
    for (const selector of selectors) {
      if (!selector || !(scope === selector || scope.startsWith(`${selector}.`))) continue;
      if (!best || selector.length >= best.length) best = { length: selector.length, settings: rule.settings };
    }
  }
  if (!best || (!best.settings.foreground && !best.settings.fontStyle)) return null;
  const font = best.settings.fontStyle ?? "";
  return { ...(best.settings.foreground ? { color: best.settings.foreground } : {}), ...(font.includes("italic") ? { fontStyle: "italic" as const } : {}), ...(font.includes("bold") ? { fontWeight: 600 } : {}) };
}

/** How the theme paints a kind of token; null leaves it in the theme's foreground. */
export function styleOf(theme: CodeTheme | null, kind: string | null): TokenStyle | null {
  if (!theme || !kind) return null;
  let cache = styles.get(theme);
  if (!cache) styles.set(theme, (cache = new Map()));
  const known = cache.get(kind);
  if (known !== undefined) return known;
  // "title.function.invoke" falls back to "title.function", then "title".
  let scopes: readonly string[] | undefined;
  for (let name = kind; !scopes && name; name = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "") scopes = SCOPES[name];
  let style: TokenStyle | null = null;
  for (const scope of scopes ?? []) if ((style = styleOfScope(theme, scope))) break;
  cache.set(kind, style);
  return style;
}
