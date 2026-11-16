// RPC tags. Reads declare them in the contract; the service invalidates them.
export const TAGS = {
  status: "status",
  views: "views",
  search: (queryId: string) => `search:${queryId}`,
  issue: (key: string) => `issue:${key}`,
  thread: (threadId: string) => `thread:${threadId}`,
};
