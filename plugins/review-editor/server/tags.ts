// RPC tags: reads declare them, the service invalidates them where data
// changes. Pure (no zod) so the frontend's contract can share it.

export const tags = {
  /** Every comment read. */
  comments: "comments",
  envComments: (environmentId: string) => `comments:${environmentId}`,
  threadComments: (threadId: string) => `thread-comments:${threadId}`,
  comment: (id: string) => `comment:${id}`,
  /** One file's working-tree content. */
  file: (environmentId: string, path: string) => `file:${environmentId}:${path}`,
  /** Every working-tree read in an environment (external edits). */
  envFiles: (environmentId: string) => `files:${environmentId}`,
  /** Git state: changed files and base sides. */
  git: (environmentId: string) => `git:${environmentId}`,
};

/** The tags each read method declares, by method. */
export const readTags = {
  readFile: ({ environmentId, path }: { environmentId: string; path: string }) => [
    tags.file(environmentId, path),
    tags.envFiles(environmentId),
  ],
  readBase: ({ environmentId }: { environmentId: string }) => [tags.git(environmentId)],
  changedFiles: ({ environmentId }: { environmentId: string }) => [tags.git(environmentId), tags.envComments(environmentId)],
  listComments: (input: { environmentId?: string; sentThreadId?: string }) => [
    tags.comments,
    ...(input.environmentId === undefined ? [] : [tags.envComments(input.environmentId)]),
    ...(input.sentThreadId === undefined ? [] : [tags.threadComments(input.sentThreadId)]),
  ],
  getComment: ({ id }: { id: string }) => [tags.comment(id)],
};
