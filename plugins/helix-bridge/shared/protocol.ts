// The Helix bridge wire contract, version 1 (helix-bb bb-bridge/PROTOCOL.md),
// as TypeScript types and constants. Shared by the host entry (which speaks
// it) and the server (which builds params and reads results). No runtime
// dependencies, so the host bundle stays small.

export const PROTOCOL_VERSION = 1;
export const CLIENT_NAME = "bb-plugin";
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export const ERROR_CODES = {
  parse_error: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  not_found: 1001,
  version_mismatch: 1002,
  buffer_modified: 1003,
  no_language_server: 1004,
  timeout: 1005,
  too_large: 1006,
  unsupported: 1007,
  cancelled: 1008,
} as const;
export type ErrorName = keyof typeof ERROR_CODES;

export function errorName(code: number): ErrorName | null {
  for (const [name, value] of Object.entries(ERROR_CODES)) if (value === code) return name as ErrorName;
  return null;
}

export const CAPABILITIES = ["editor", "reload", "locations", "views", "command", "diagnostics", "lsp", "applyEdits", "annotations", "reveal", "review", "watch"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const EVENT_KINDS = ["selection", "documents", "diagnostics", "mode", "send", "lsp", "externalChange"] as const;

export interface Position {
  line: number;
  col: number;
}
export interface Range {
  start: Position;
  end: Position;
}

/** `<cache>/bridge/<pid>.json`. */
export interface RegistryFile {
  protocol: number;
  pid: number;
  socket: string;
  helixVersion?: string;
  startedAt?: string;
  cwd?: string;
  workspaceRoot?: string;
  env?: Partial<Record<"BB_THREAD_ID" | "BB_ENVIRONMENT_ID" | "BB_PROJECT_ID" | "BB_TERMINAL_ID" | "BB_TERMINAL_SESSION_ID", string>>;
  /** Set only by the plugin's mock bridge: never map this instance by workspace. */
  test?: boolean;
}

export interface HelloResult {
  protocol: number;
  helixVersion: string;
  pid: number;
  cwd: string;
  workspaceRoot: string;
  capabilities: string[];
  commandPolicy?: "safe" | "all" | "none";
}

export interface DocumentMeta {
  docId: number;
  path: string | null;
  languageId: string;
  version: number;
  modified: boolean;
}

export interface EditorState {
  mode: "normal" | "insert" | "select";
  focused: DocumentMeta & { selections: Range[]; primary: number; visible: { firstLine: number; lastLine: number } };
  documents: DocumentMeta[];
}

export interface SelectionResult {
  path: string | null;
  docId: number;
  languageId: string;
  version: number;
  modified: boolean;
  primary: number;
  ranges: (Range & { text: string })[];
  truncated: boolean;
}

export interface ReloadResult {
  reloaded: string[];
  unchanged: string[];
  skippedModified: string[];
  missing: string[];
}

export interface OpenResult {
  docId: number;
  path: string;
  version: number;
  viewId: number | null;
  deferred?: boolean;
}

export interface LocationItem {
  path: string;
  line: number;
  col?: number;
  endLine?: number;
  label?: string;
  note?: string;
}

export interface ViewInfo {
  viewId: number;
  docId: number;
  path: string | null;
  focused: boolean;
  area: { x: number; y: number; width: number; height: number };
  firstLine: number;
  lastLine: number;
}
export type LayoutNode = { split: "horizontal" | "vertical"; children: LayoutNode[] } | { viewId: number };

export interface Diagnostic {
  path: string;
  range: Range;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  code?: string | number;
  server?: string;
}

export interface Location {
  path: string;
  range: Range;
  preview: string;
}
export interface SymbolInfo {
  name: string;
  kind: string;
  location: Location;
  container?: string;
  /** The whole symbol, for nested answers (gopls, rust-analyzer). */
  extent?: Range;
}

export const QUERY_KINDS = [
  "definition",
  "typeDefinition",
  "implementation",
  "references",
  "hover",
  "documentSymbols",
  "workspaceSymbols",
  "incomingCalls",
  "outgoingCalls",
  "renamePreview",
] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

export type SendKind = "send" | "ask" | "comment" | "flush";
export interface SendEvent {
  kind: SendKind;
  note: string;
  path: string | null;
  docId: number;
  languageId: string;
  version: number;
  modified: boolean;
  ranges: (Range & { text: string })[];
  truncated: boolean;
  sendNow: boolean;
}
