// Which syntax a file gets, and which extensions the editor opens. The
// language table is data only (no CodeMirror imports) so it stays testable;
// app/editor/languages.ts turns an id into a CodeMirror extension.

export type LanguageId =
  | "javascript" | "jsx" | "typescript" | "tsx" | "json" | "css" | "html" | "markdown"
  | "python" | "yaml" | "shell" | "toml" | "go" | "rust" | "ruby" | "swift" | "sql"
  | "dockerfile" | "diff" | "properties" | "lua" | "perl" | "r" | "nginx" | "protobuf"
  | "c" | "cpp" | "java" | "csharp" | "kotlin" | "scala" | "dart" | "objectivec"
  | "clojure" | "haskell" | "erlang" | "groovy" | "powershell" | "xml" | "text";

const BY_EXTENSION: Record<string, LanguageId> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", vue: "html", svelte: "html", astro: "html",
  xml: "xml", svg: "xml", plist: "xml",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  py: "python", pyi: "python",
  yml: "yaml", yaml: "yaml",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  toml: "toml", go: "go", rs: "rust", rb: "ruby", swift: "swift", sql: "sql",
  diff: "diff", patch: "diff",
  properties: "properties", ini: "properties", cfg: "properties", conf: "properties", env: "properties",
  lua: "lua", pl: "perl", pm: "perl", r: "r", proto: "protobuf",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  java: "java", cs: "csharp", kt: "kotlin", kts: "kotlin", scala: "scala", dart: "dart",
  m: "objectivec", mm: "objectivec",
  clj: "clojure", cljs: "clojure", edn: "clojure", hs: "haskell", erl: "erlang",
  groovy: "groovy", gradle: "groovy", ps1: "powershell",
  txt: "text", log: "text", csv: "text", tsv: "text", lock: "text",
};

const BY_NAME: Record<string, LanguageId> = {
  dockerfile: "dockerfile",
  makefile: "shell",
  ".gitignore": "properties",
  ".gitattributes": "properties",
  ".editorconfig": "properties",
  ".npmrc": "properties",
  ".env": "properties",
};

export function languageFor(path: string): LanguageId {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (BY_NAME[name] !== undefined) return BY_NAME[name];
  if (name.startsWith(".env.")) return "properties";
  if (name.startsWith("dockerfile.")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "text";
  return BY_EXTENSION[name.slice(dot + 1)] ?? "text";
}

/**
 * Extensions the fileOpener claims: source, config, markup, Markdown and
 * plain text. Users can pin another opener per extension in Settings.
 */
// Images and tables keep BB's own preview, which shows them better than text.
const KEEP_PREVIEW = new Set(["svg", "csv", "tsv", "plist"]);

export const OPENER_EXTENSIONS: readonly string[] = Object.keys(BY_EXTENSION)
  .filter((extension) => /^[a-z0-9]+$/u.test(extension) && !KEEP_PREVIEW.has(extension))
  .sort();
