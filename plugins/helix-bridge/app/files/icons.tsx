// The tree's own icons, drawn for a 16 px slot in a narrow rail. Every file is
// a page with a folded corner. A kind the tree knows fills the page with its
// hue (DESIGN.md's categorical tints) and writes its letters, or a small mark,
// on the lower half; any other file is the bare page. Folders are outlines in
// the text colour, so the names and the kinds are what the eye finds.
import { memo, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Hue = "cyan" | "green" | "blue" | "yellow" | "indigo" | "orange" | "lime" | "amber" | "gray" | "purple" | "teal" | "violet" | "red" | "pink" | "sky" | "fuchsia";

// Full class strings so Tailwind's scanner sees them; `in-[.dark]:` follows bb's theme.
const HUE: Record<Hue, string> = {
  cyan: "text-cyan-600 in-[.dark]:text-cyan-400",
  green: "text-green-600 in-[.dark]:text-green-400",
  blue: "text-blue-600 in-[.dark]:text-blue-400",
  yellow: "text-yellow-600 in-[.dark]:text-yellow-300",
  indigo: "text-indigo-600 in-[.dark]:text-indigo-300",
  orange: "text-orange-600 in-[.dark]:text-orange-400",
  lime: "text-lime-700 in-[.dark]:text-lime-400",
  amber: "text-amber-600 in-[.dark]:text-amber-400",
  gray: "text-gray-500 in-[.dark]:text-gray-400",
  purple: "text-purple-600 in-[.dark]:text-purple-300",
  teal: "text-teal-600 in-[.dark]:text-teal-400",
  violet: "text-violet-600 in-[.dark]:text-violet-300",
  red: "text-red-600 in-[.dark]:text-red-400",
  pink: "text-pink-600 in-[.dark]:text-pink-400",
  sky: "text-sky-600 in-[.dark]:text-sky-400",
  fuchsia: "text-fuchsia-600 in-[.dark]:text-fuchsia-400",
};

type Mark = "lines" | "lock" | "image" | "braces" | "angle";
export interface Kind {
  /** What it is, in words (the icon's title). */
  label: string;
  hue: Hue;
  /** One or two letters, or a mark. */
  text?: string;
  mark?: Mark;
}

const K = {
  go: { label: "Go", hue: "cyan", text: "go" },
  goMod: { label: "Go module", hue: "cyan", mark: "lines" },
  goSum: { label: "Go checksums", hue: "gray", mark: "lock" },
  bazel: { label: "Bazel", hue: "green", text: "bz" },
  ts: { label: "TypeScript", hue: "blue", text: "ts" },
  js: { label: "JavaScript", hue: "yellow", text: "js" },
  py: { label: "Python", hue: "indigo", text: "py" },
  rs: { label: "Rust", hue: "orange", text: "rs" },
  sh: { label: "Shell", hue: "lime", text: "sh" },
  json: { label: "JSON", hue: "amber", mark: "braces" },
  config: { label: "Configuration", hue: "gray", mark: "lines" },
  md: { label: "Markdown", hue: "purple", text: "md" },
  text: { label: "Text", hue: "gray", mark: "lines" },
  proto: { label: "Protocol Buffers", hue: "teal", text: "pb" },
  sql: { label: "SQL", hue: "violet", text: "sq" },
  html: { label: "HTML", hue: "red", mark: "angle" },
  css: { label: "CSS", hue: "pink", text: "#" },
  docker: { label: "Docker", hue: "sky", text: "dk" },
  make: { label: "Make", hue: "gray", text: "mk" },
  image: { label: "Image", hue: "fuchsia", mark: "image" },
  lock: { label: "Lock file", hue: "gray", mark: "lock" },
  license: { label: "License", hue: "gray", text: "©" },
  c: { label: "C", hue: "sky", text: "c" },
  cpp: { label: "C++", hue: "sky", text: "c+" },
  java: { label: "Java", hue: "orange", text: "jv" },
  rb: { label: "Ruby", hue: "red", text: "rb" },
  lua: { label: "Lua", hue: "blue", text: "lu" },
  nix: { label: "Nix", hue: "sky", text: "nx" },
  tf: { label: "Terraform", hue: "violet", text: "tf" },
  graphql: { label: "GraphQL", hue: "pink", text: "gq" },
  csv: { label: "Table", hue: "green", mark: "lines" },
} satisfies Record<string, Kind>;

/** By exact name, lowercase. */
const BY_NAME: Record<string, Kind> = {
  build: K.bazel,
  "build.bazel": K.bazel,
  workspace: K.bazel,
  "workspace.bazel": K.bazel,
  "module.bazel": K.bazel,
  "module.bazel.lock": K.lock,
  ".bazelrc": K.bazel,
  ".bazelversion": K.bazel,
  ".bazelignore": K.bazel,
  "go.mod": K.goMod,
  "go.work": K.goMod,
  "go.sum": K.goSum,
  "go.work.sum": K.goSum,
  makefile: K.make,
  gnumakefile: K.make,
  justfile: K.make,
  dockerfile: K.docker,
  containerfile: K.docker,
  ".dockerignore": K.docker,
  "docker-compose.yml": K.docker,
  "docker-compose.yaml": K.docker,
  "compose.yml": K.docker,
  "compose.yaml": K.docker,
  license: K.license,
  "license.md": K.license,
  "license.txt": K.license,
  copying: K.license,
  notice: K.license,
  "cargo.lock": K.lock,
  "package-lock.json": K.lock,
  "yarn.lock": K.lock,
  "pnpm-lock.yaml": K.lock,
  "poetry.lock": K.lock,
  "uv.lock": K.lock,
  ".gitignore": K.config,
  ".gitattributes": K.config,
  ".gitmodules": K.config,
  ".editorconfig": K.config,
  ".env": K.config,
  ".npmrc": K.config,
  ".nvmrc": K.config,
  ".prettierrc": K.config,
  ".eslintrc": K.config,
  ".bashrc": K.sh,
  ".zshrc": K.sh,
  ".profile": K.sh,
};

/** By extension, lowercase. */
const BY_EXT: Record<string, Kind> = {
  go: K.go,
  bzl: K.bazel,
  bazel: K.bazel,
  star: K.bazel,
  ts: K.ts,
  tsx: K.ts,
  mts: K.ts,
  cts: K.ts,
  js: K.js,
  jsx: K.js,
  mjs: K.js,
  cjs: K.js,
  py: K.py,
  pyi: K.py,
  ipynb: K.py,
  rs: K.rs,
  sh: K.sh,
  bash: K.sh,
  zsh: K.sh,
  fish: K.sh,
  json: K.json,
  jsonc: K.json,
  json5: K.json,
  yaml: K.config,
  yml: K.config,
  toml: K.config,
  ini: K.config,
  cfg: K.config,
  conf: K.config,
  env: K.config,
  xml: K.config,
  plist: K.config,
  md: K.md,
  mdx: K.md,
  rst: K.md,
  adoc: K.md,
  txt: K.text,
  log: K.text,
  proto: K.proto,
  sql: K.sql,
  html: K.html,
  htm: K.html,
  tmpl: K.html,
  gotmpl: K.html,
  templ: K.html,
  css: K.css,
  scss: K.css,
  sass: K.css,
  less: K.css,
  png: K.image,
  jpg: K.image,
  jpeg: K.image,
  gif: K.image,
  webp: K.image,
  svg: K.image,
  ico: K.image,
  avif: K.image,
  lock: K.lock,
  c: K.c,
  h: K.c,
  cc: K.cpp,
  cpp: K.cpp,
  cxx: K.cpp,
  hpp: K.cpp,
  hh: K.cpp,
  java: K.java,
  kt: K.java,
  rb: K.rb,
  lua: K.lua,
  nix: K.nix,
  tf: K.tf,
  tfvars: K.tf,
  hcl: K.tf,
  graphql: K.graphql,
  gql: K.graphql,
  csv: K.csv,
  tsv: K.csv,
  mk: K.make,
  dockerfile: K.docker,
};

/** The kind of a file by its name, or null for the plain page. */
export function kindOf(name: string): Kind | null {
  const lower = name.toLowerCase();
  const exact = BY_NAME[lower];
  if (exact) return exact;
  if (lower.startsWith("dockerfile.")) return K.docker;
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return null;
  return BY_EXT[lower.slice(dot + 1)] ?? null;
}

const PAGE = "M4 1.5h5.6L13 4.9V13.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z";
const FOLD = "M9.5 1.5V5H13";
const FOLDER = "M2 4.1a1.5 1.5 0 0 1 1.5-1.5H6l1.5 1.6h5A1.5 1.5 0 0 1 14 5.7v6.3a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12Z";
const FOLDER_BACK = "M2 12.5V3.6a1 1 0 0 1 1-1h3l1.5 1.6H12a1 1 0 0 1 1 1V7";
const FOLDER_FRONT = "M2 12.5 3.7 7.6a1 1 0 0 1 .95-.7H14a.6.6 0 0 1 .57.8l-1.5 4.4a1 1 0 0 1-.95.7H2Z";

/** A mark as two paths: one stroked, one filled. */
const MARKS: Record<Mark, { stroke: string; fill: string }> = {
  lines: { stroke: "M5.5 9h5M5.5 11h5M5.5 13h3", fill: "" },
  lock: { stroke: "M6.4 9.5V8.6a1.6 1.6 0 0 1 3.2 0v.9", fill: "M5.85 9.5h4.3a.6.6 0 0 1 .6.6v2.55a.6.6 0 0 1-.6.6h-4.3a.6.6 0 0 1-.6-.6V10.1a.6.6 0 0 1 .6-.6Z" },
  image: { stroke: "", fill: "m4.8 13.2 2.6-3 1.6 1.8 1-1.1 1.4 2.3ZM11.1 8.2a.9.9 0 1 1-1.8 0a.9.9 0 1 1 1.8 0Z" },
  braces: { stroke: "M6.6 8.4c-.9 0-.9.5-.9 1v.6c0 .4-.3.6-.7.6.4 0 .7.2.7.6v.6c0 .5 0 1 .9 1M9.4 8.4c.9 0 .9.5.9 1v.6c0 .4.3.6.7.6-.4 0-.7.2-.7.6v.6c0 .5 0 1-.9 1", fill: "" },
  angle: { stroke: "m6.6 9-1.6 1.8 1.6 1.8M9.4 9l1.6 1.8-1.6 1.8", fill: "" },
};

/**
 * Every icon has the same elements (a body, a second outline, a mark's stroke
 * and fill, letters): only their attributes and text change, so a row that
 * shows another entry while scrolling adds nothing to the document (see
 * TreeRows' BLOCK).
 */
export const EntryIcon = memo(function EntryIcon({ dir, open = false, name, className }: { dir: boolean; open?: boolean; name: string; className?: string }) {
  const kind = dir ? null : kindOf(name);
  const mark = kind?.mark ? MARKS[kind.mark] : null;
  const body = dir ? (open ? FOLDER_BACK : FOLDER) : PAGE;
  const second = dir ? (open ? FOLDER_FRONT : "") : FOLD;
  const tinted = dir || kind !== null;
  const text = kind?.text ?? "";
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4 shrink-0", kind ? HUE[kind.hue] : "text-muted-foreground", className)}
      aria-hidden
      data-kind={dir ? (open ? "folder-open" : "folder") : (kind?.label ?? "file")}
    >
      <path d={body} fill={tinted && !(dir && open) ? "currentColor" : "none"} fillOpacity={dir ? 0.12 : 0.16} strokeWidth={kind ? 1 : 1.1} strokeOpacity={kind ? 0.7 : 1} />
      <path d={second} fill={dir ? "currentColor" : "none"} fillOpacity={0.12} strokeWidth={kind ? 1 : 1.1} strokeOpacity={kind ? 0.7 : 1} />
      <path d={mark?.stroke ?? ""} strokeWidth={1.1} />
      <path d={mark?.fill ?? ""} fill="currentColor" stroke="none" />
      <text x="8" y="13" textAnchor="middle" fill="currentColor" stroke="none" fontSize={text.length > 1 ? 6.2 : 7} fontWeight={700} letterSpacing={-0.2} style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
        {text || " "}
      </text>
    </svg>
  );
});

/** A file: the page, and its kind when the tree knows it. */
export const FileIcon = ({ name, className }: { name: string; className?: string }) => <EntryIcon dir={false} name={name} className={className} />;

/** A folder, closed or open. */
export const FolderIcon = ({ open, className }: { open: boolean; className?: string }) => <EntryIcon dir open={open} name="" className={className} />;

/** The tree's chrome: a chevron, the search glass, new file and folder, a link, a cross. */
const UI = {
  chevron: <path d="m6 4 4 4-4 4" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.2 10.2 3.3 3.3" />
    </>
  ),
  newFile: (
    <>
      <path d="M9 14.5H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1h5.6L13 4.9V8.5" />
      <path d="M9.5 1.5V5H13" />
      <path d="M12.5 11v4M10.5 13h4" />
    </>
  ),
  newFolder: (
    <>
      <path d="M8 13.5H3.5A1.5 1.5 0 0 1 2 12V4.1a1.5 1.5 0 0 1 1.5-1.5H6l1.5 1.6h5A1.5 1.5 0 0 1 14 5.7v2.8" />
      <path d="M12.5 10v4.5M10.25 12.25h4.5" />
    </>
  ),
  link: (
    <>
      <path d="M6.5 9.5 9.5 6.5" />
      <path d="M7.2 4.6 8.4 3.4a2.5 2.5 0 0 1 3.5 3.5l-1.2 1.2" />
      <path d="M8.8 11.4 7.6 12.6a2.5 2.5 0 0 1-3.5-3.5l1.2-1.2" />
    </>
  ),
  close: <path d="m4.5 4.5 7 7m0-7-7 7" />,
  trash: (
    <>
      <path d="M3 4.5h10M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5" />
      <path d="m4.5 4.5.6 8.6a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.6" />
    </>
  ),
  warn: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 5v3.5M8 10.9v.1" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type UiGlyphName = keyof typeof UI;

export function UiGlyph({ name, className }: { name: UiGlyphName; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" className={cn("size-4 shrink-0", className)} aria-hidden>
      {UI[name]}
    </svg>
  );
}
