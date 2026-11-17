// The contract between the server entry and the host entry (bb.host), which
// runs on the machine where Helix runs and owns every socket. Validated at
// both ends; the host reports state, the server decides what it means.
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** An absolute directory, or empty for Helix's default cache rules. */
const bridgeDirSchema = z.string().max(4096).optional();

const positionSchema = z.object({ line: z.number().int(), col: z.number().int() });

export const instanceSummarySchema = z.object({
  /** Unique on its host: the pid plus the registry's start time. */
  id: z.string(),
  pid: z.number().int(),
  socket: z.string(),
  helixVersion: z.string().nullable(),
  startedAt: z.string().nullable(),
  cwd: z.string().nullable(),
  workspaceRoot: z.string().nullable(),
  env: z.record(z.string(), z.string()),
  /** A test instance (the mock bridge): bound only explicitly. */
  test: z.boolean(),
  status: z.enum(["connecting", "connected", "disconnected", "incompatible"]),
  protocol: z.number().int().nullable(),
  capabilities: z.array(z.string()),
  commandPolicy: z.string().nullable(),
  error: z.string().nullable(),
  mode: z.string().nullable(),
  focus: z
    .object({
      path: z.string().nullable(),
      docId: z.number().int(),
      languageId: z.string().nullable(),
      modified: z.boolean(),
      cursor: positionSchema.nullable(),
      /** The primary selection's far end when it has extent. */
      anchor: positionSchema.nullable(),
      selections: z.number().int(),
    })
    .nullable(),
  diagnostics: z.object({ errors: z.number().int(), warnings: z.number().int() }),
  documents: z.number().int(),
  lspServers: z.array(z.string()),
  externalChanges: z.array(z.string()),
  pendingSends: z.number().int(),
  overflows: z.number().int(),
  dropped: z.number().int(),
  events: z.number().int(),
  updatedAt: z.number(),
});
export type InstanceSummary = z.infer<typeof instanceSummarySchema>;

const bridgeErrorSchema = z.object({
  /** JSON-RPC code, or 0 for a transport failure on our side. */
  code: z.number().int(),
  /** A PROTOCOL.md error name, or not_connected / transport. */
  name: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type BridgeCallError = z.infer<typeof bridgeErrorSchema>;

export const sendRecordSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  receivedAt: z.number(),
  event: z.record(z.string(), z.unknown()),
});
export type SendRecord = z.infer<typeof sendRecordSchema>;

const checkSchema = z.object({
  id: z.string(),
  label: z.string(),
  ok: z.boolean(),
  /** "warn" for something that works without it. */
  level: z.enum(["ok", "warn", "error"]),
  detail: z.string(),
  fix: z.string().nullable(),
});
export type DoctorCheck = z.infer<typeof checkSchema>;

export const fontFaceSchema = z.object({ fullName: z.string(), postscriptName: z.string().nullable() });
export type FontFace = z.infer<typeof fontFaceSchema>;

export const ghosttyConfigSchema = z.object({
  path: z.string(),
  found: z.boolean(),
  fontFamily: z.string().nullable(),
  fontSize: z.number().nullable(),
  fontStyle: z.string().nullable(),
  fontStyleBold: z.string().nullable().optional(),
  fontStyleItalic: z.string().nullable().optional(),
  fontStyleBoldItalic: z.string().nullable().optional(),
  /**
   * The installed faces for the effective family and styles, by full and
   * PostScript name (CSS `local()`), so the surface draws the faces Ghostty
   * would: the base style as normal weight, the bold style as bold.
   */
  faces: z
    .object({ regular: fontFaceSchema.nullable(), bold: fontFaceSchema.nullable(), italic: fontFaceSchema.nullable(), boldItalic: fontFaceSchema.nullable() })
    .optional(),
  boldIsBright: z.boolean().nullable(),
  optionAsAlt: z.enum(["true", "false", "left", "right"]),
  theme: z.string().nullable(),
  background: z.string().nullable(),
  foreground: z.string().nullable(),
});
export type GhosttyConfig = z.infer<typeof ghosttyConfigSchema>;

export const hostContract = defineRpcContract({
  instances: {
    experimental_description: "Start watching the bridge directory if needed and list the Helix instances found there.",
    input: z.object({ bridgeDir: bridgeDirSchema }).strict(),
    output: z.object({
      bridgeDir: z.string(),
      dirExists: z.boolean(),
      instances: z.array(instanceSummarySchema),
    }),
  },
  call: {
    experimental_description: "One JSON-RPC request to an instance; errors come back as values.",
    input: z
      .object({
        bridgeDir: bridgeDirSchema,
        instanceId: z.string().min(1).max(128),
        method: z.string().min(1).max(64),
        params: z.record(z.string(), z.unknown()).optional(),
        timeoutMs: z.number().int().min(100).max(65_000).optional(),
      })
      .strict(),
    output: z.union([
      z.object({ ok: z.literal(true), result: z.unknown() }),
      z.object({ ok: z.literal(false), error: bridgeErrorSchema }),
    ]),
  },
  pendingSends: {
    experimental_description: "`event/send` notifications not yet acknowledged by the server.",
    input: z.object({}).strict(),
    output: z.object({ sends: z.array(sendRecordSchema) }),
  },
  ackSends: {
    experimental_description: "Forget sends the server has handled.",
    input: z.object({ ids: z.array(z.string()).max(500) }).strict(),
    output: z.object({ remaining: z.number().int() }),
  },
  doctor: {
    experimental_description: "Check the editor binary, the bridge directory, the tools and the font on this machine.",
    input: z.object({ bridgeDir: bridgeDirSchema, hxbPath: z.string().max(4096), fontFamily: z.string().max(256).nullable() }).strict(),
    output: z.object({ checks: z.array(checkSchema), hxbResolved: z.string().nullable(), hxbVersion: z.string().nullable() }),
  },
  perfMode: {
    experimental_description: "Diagnostics for latency A/B runs on one instance: normal, quiet (no updates to bb) or off (no event subscriptions).",
    input: z.object({ instanceId: z.string(), mode: z.enum(["normal", "quiet", "off"]) }).strict(),
    output: z.object({ found: z.boolean() }),
  },
  gitRead: {
    experimental_description: "Read-only git for reviews: resolve a revision, a commit's subject, the snapshot a turn starts from, files and diff against a base.",
    input: z
      .object({
        cwd: z.string().min(1).max(4096),
        op: z.enum(["revParse", "subject", "snapshot", "changedFiles", "diff"]),
        rev: z.string().max(200).optional(),
        exclude: z.array(z.string().max(4096)).max(20_000).optional(),
      })
      .strict(),
    output: z.object({
      sha: z.string().nullable().optional(),
      subject: z.string().optional(),
      base: z.string().nullable().optional(),
      untracked: z.array(z.string()).optional(),
      files: z.array(z.object({ path: z.string(), oldPath: z.string().optional(), status: z.enum(["added", "modified", "deleted", "renamed"]), additions: z.number(), deletions: z.number() })).optional(),
      diff: z.string().optional(),
      error: z.string().nullable(),
    }),
  },
  yaziPrepare: {
    experimental_description: "Find yazi and write the file tree's configuration directory (layered on the user's, which is never written).",
    input: z.object({}).strict(),
    output: z.object({ yazi: z.string().nullable(), ya: z.string().nullable(), version: z.string().nullable(), configDir: z.string().nullable(), opener: z.string().nullable().optional(), userConfig: z.string().nullable() }),
  },
  yaziEmit: {
    experimental_description: "Send a command to a running file tree (ya emit-to).",
    input: z.object({ clientId: z.string().regex(/^\d{1,15}$/u), name: z.enum(["reveal", "cd", "hidden", "escape"]), args: z.array(z.string().max(4096)).max(4) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
  },
  ghosttyConfig: {
    experimental_description: "The user's Ghostty configuration, read only, with the installed faces for the effective font (the plugin's overrides applied).",
    experimental_retryable: true,
    input: z.object({ fontFamily: z.string().max(200).optional(), fontStyle: z.string().max(64).optional() }).strict(),
    output: ghosttyConfigSchema,
  },

});

export const hostSignals = {
  /** Every instance's summary, coalesced: at most a few per second. */
  state: {
    payload: z.object({ bridgeDir: z.string(), instances: z.array(instanceSummarySchema) }),
  },
} satisfies ExperimentalHostSignals;
