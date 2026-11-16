// The RPC contract as the frontend needs it: method names and read tags,
// with pass-through input schemas. The live hooks validate input only to
// compute tags (the server validates for real), so the app never bundles zod.
import type { StandardSchemaV1 } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../server/contract";
import { readTags } from "../server/tags";

const passthrough: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "review-editor", validate: (value: unknown) => ({ value }) },
};

const METHODS = [
  "resolveHostFile", "readFile", "readBase", "saveFile", "changedFiles", "listComments", "getComment",
  "createComment", "updateComment", "deleteComment", "setCommentState", "acknowledgeComments", "replyToComment", "syncAnchors",
  "compilePrompt", "markSent", "sendToThread",
] as const satisfies readonly (keyof RpcContract)[];

type Missing = Exclude<keyof RpcContract, (typeof METHODS)[number]>;
// Fails to compile when the server contract gains a method this list lacks.
const complete: Missing extends never ? true : false = true;
void complete;

export const clientContract = Object.fromEntries(
  METHODS.map((method) => [
    method,
    {
      input: passthrough,
      output: passthrough,
      ...(method in readTags ? { tags: readTags[method as keyof typeof readTags] } : {}),
    },
  ]),
) as unknown as RpcContract;
