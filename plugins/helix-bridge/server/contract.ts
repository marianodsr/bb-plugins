// The RPC contract the app uses. Reads declare tags; the server invalidates
// `instances` when anything the app shows changes structurally (instances,
// bindings, status, focused file, counts). Cursor moves go over realtime
// (`position`), never through a bb write.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ghosttyConfigSchema } from "../shared/host-contract";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const instanceKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/u);

export const tags = {
  instances: "instances",
  drafts: (threadId: string) => `drafts:${threadId}`,
  setup: "setup",
  review: (threadId: string) => `review:${threadId}`,
};

export const appInstanceSchema = z.object({
  key: z.string(),
  hostId: z.string(),
  pid: z.number().int(),
  status: z.string(),
  error: z.string().nullable(),
  helixVersion: z.string().nullable(),
  workspaceRoot: z.string().nullable(),
  threadId: z.string().nullable(),
  threadTitle: z.string().nullable(),
  bindingSource: z.enum(["terminal", "explicit", "environment"]).nullable(),
  terminalId: z.string().nullable(),
  /** Display path (relative to the workspace) and cursor of the focused buffer. */
  focus: z.object({ path: z.string().nullable(), absolutePath: z.string().nullable(), line: z.number().nullable(), col: z.number().nullable(), endLine: z.number().nullable(), modified: z.boolean() }).nullable(),
  mode: z.string().nullable(),
  diagnostics: z.object({ errors: z.number(), warnings: z.number() }),
  capabilities: z.array(z.string()),
  commandPolicy: z.string().nullable(),
  pendingSends: z.number(),
  skippedModified: z.array(z.string()),
});
export type AppInstance = z.infer<typeof appInstanceSchema>;

export const positionSchema = z.object({ key: z.string(), threadId: z.string().nullable(), path: z.string().nullable(), absolutePath: z.string().nullable(), line: z.number().nullable(), col: z.number().nullable(), endLine: z.number().nullable(), mode: z.string().nullable() });
export type Position = z.infer<typeof positionSchema>;

const draftSchema = z.object({ id: z.string(), threadId: z.string(), text: z.string(), summary: z.string(), createdAt: z.number() });

export const rpcContract = defineRpcContract({
  instances: {
    experimental_description: "Every Helix instance on every machine with its bound thread.",
    input: z.null(),
    output: z.object({ instances: z.array(appInstanceSchema), hosts: z.array(z.object({ hostId: z.string(), bridgeDir: z.string(), dirExists: z.boolean(), error: z.string().nullable(), instances: z.number() })) }),
    tags: () => [tags.instances],
  },
  threadStatus: {
    experimental_description: "The Helix serving a thread (bound to it, or in its environment), if any.",
    input: z.object({ threadId: id }).strict(),
    output: z.object({ instance: appInstanceSchema.nullable(), candidates: z.number() }),
    tags: () => [tags.instances],
  },
  bind: {
    experimental_description: "Bind an instance to a thread.",
    input: z.object({ instanceKey, threadId: id }).strict(),
    output: appInstanceSchema,
  },
  unbind: {
    experimental_description: "Remove an instance's explicit binding.",
    input: z.object({ instanceKey }).strict(),
    output: appInstanceSchema,
  },
  reload: {
    experimental_description: "Reload an instance's buffers that changed on disk.",
    input: z.object({ instanceKey }).strict(),
    output: z.object({ reloaded: z.number(), skippedModified: z.array(z.string()) }),
  },
  drafts: {
    experimental_description: "Selections sent from Helix waiting to land in this thread's composer.",
    input: z.object({ threadId: id }).strict(),
    output: z.object({ drafts: z.array(draftSchema) }),
    tags: ({ threadId }) => [tags.drafts(threadId)],
  },
  takeDraft: {
    experimental_description: "Remove a draft once the app put it in the composer.",
    input: z.object({ id: z.string().regex(/^drf_[a-z0-9-]{1,32}$/u) }).strict(),
    output: z.object({ taken: z.boolean() }),
  },
  setup: {
    experimental_description: "Doctor checks for this bb's machine: binary, protocol, bridge directory, tools, font.",
    input: z.null(),
    output: z.object({ ready: z.boolean(), checks: z.array(z.object({ id: z.string(), label: z.string(), level: z.enum(["ok", "warn", "error"]), detail: z.string(), fix: z.string().nullable() })) }),
    tags: () => [tags.setup],
  },
  ghostty: {
    experimental_description: "The editor surface's look: the user's Ghostty config with this plugin's overrides.",
    input: z.object({ fontStyle: z.string().max(64).optional() }).strict().nullable(),
    output: ghosttyConfigSchema.extend({ hud: z.boolean() }),
  },
  commentsChanged: {
    experimental_description: "Review Editor wrote a comment on this file: re-send its annotations to Helix. Returns at once.",
    input: z.object({ environmentId: id, path: z.string().min(1).max(4096) }).strict(),
    output: z.object({ accepted: z.boolean() }),
  },
  treeTerminal: {
    experimental_description: "The thread's file tree session (yazi), started if needed; or what to install.",
    input: z.object({ threadId: id }).strict(),
    output: z.union([
      z.object({ terminalId: z.string(), created: z.boolean(), missing: z.null() }),
      z.object({ terminalId: z.null(), created: z.literal(false), missing: z.string() }),
    ]),
  },
  treeReveal: {
    experimental_description: "Show a file in the thread's tree.",
    input: z.object({ threadId: id, path: z.string().min(1).max(4096) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  treeClose: {
    experimental_description: "Close the thread's tree (the editor closed).",
    input: z.object({ threadId: id }).strict(),
    output: z.object({ closed: z.boolean() }),
  },
  editorTerminal: {
    experimental_description: "The thread's Helix terminal session, started if needed.",
    input: z.object({ threadId: id }).strict(),
    output: z.object({ terminalId: z.string(), created: z.boolean() }),
  },
});
