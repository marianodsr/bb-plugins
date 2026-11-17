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

export const ghosttyConfigSchema = z.object({
  path: z.string(),
  found: z.boolean(),
  fontFamily: z.string().nullable(),
  fontSize: z.number().nullable(),
  fontStyle: z.string().nullable(),
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
  ghosttyConfig: {
    experimental_description: "The user's Ghostty configuration, read only.",
    experimental_retryable: true,
    input: z.object({}).strict(),
    output: ghosttyConfigSchema,
  },
});

export const hostSignals = {
  /** Every instance's summary, coalesced: at most a few per second. */
  state: {
    payload: z.object({ bridgeDir: z.string(), instances: z.array(instanceSummarySchema) }),
  },
} satisfies ExperimentalHostSignals;
