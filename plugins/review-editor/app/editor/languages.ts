// LanguageId to CodeMirror support. Lezer grammars for the common web and
// scripting languages; CodeMirror 5 stream modes for the rest (small).
import type { Extension } from "@codemirror/state";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { go } from "@codemirror/legacy-modes/mode/go";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { r } from "@codemirror/legacy-modes/mode/r";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { c, cpp, java, csharp, kotlin, scala, dart, objectiveC } from "@codemirror/legacy-modes/mode/clike";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import type { LanguageId } from "../model/languages";

const stream = (parser: StreamParser<unknown>) => () => StreamLanguage.define(parser);

const SUPPORT: Record<LanguageId, () => Extension> = {
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  css: () => css(),
  html: () => html(),
  markdown: () => markdown(),
  python: () => python(),
  yaml: () => yaml(),
  shell: stream(shell),
  toml: stream(toml),
  go: stream(go),
  rust: stream(rust),
  ruby: stream(ruby),
  swift: stream(swift),
  sql: stream(standardSQL),
  dockerfile: stream(dockerFile),
  diff: stream(diff),
  properties: stream(properties),
  lua: stream(lua),
  perl: stream(perl),
  r: stream(r),
  nginx: stream(nginx),
  protobuf: stream(protobuf),
  c: stream(c),
  cpp: stream(cpp),
  java: stream(java),
  csharp: stream(csharp),
  kotlin: stream(kotlin),
  scala: stream(scala),
  dart: stream(dart),
  objectivec: stream(objectiveC),
  clojure: stream(clojure),
  haskell: stream(haskell),
  erlang: stream(erlang),
  groovy: stream(groovy),
  powershell: stream(powerShell),
  xml: stream(xml),
  text: () => [],
};

export function languageSupport(id: LanguageId): Extension {
  return SUPPORT[id]();
}
