// What the tree knows about the thread around it: the agent's trail (the
// files its running and last turns changed) and the review at a glance (files
// not viewed, open comments), per row and added up on closed folders. All of
// it is data already in memory; nothing here reads the repository.
import { useEffect, useMemo, useState } from "react";
import type { ChangedFile, RailComment } from "../../server";
import { ancestors, compareEntries, joinPath, nameOf, type Row } from "./model";
import type { AgentFile, AgentFiles, ThreadLink } from "./types";

/** The agent's files, read once and again whenever the thread says they changed. */
export function useAgentFiles(link: ThreadLink | null | undefined): AgentFiles | null {
  const [files, setFiles] = useState<AgentFiles | null>(null);
  useEffect(() => {
    if (!link) return;
    let live = true;
    let reading = false;
    let again = false;
    const read = () => {
      if (reading) return void (again = true);
      reading = true;
      link.agentFiles().then(
        (next) => live && setFiles(next),
        () => {},
      ).finally(() => {
        reading = false;
        if (again && live) {
          again = false;
          read();
        }
      });
    };
    read();
    const off = link.onAgentFiles(read);
    return () => {
      live = false;
      off();
    };
  }, [link]);
  return files;
}

export interface Marks {
  agent: ReadonlyMap<string, AgentFile>;
  /** Folders holding the agent's files: "running" wins over "last". */
  agentIn: ReadonlyMap<string, AgentFile["turn"]>;
  unviewed: ReadonlySet<string>;
  unviewedIn: ReadonlyMap<string, number>;
  comments: ReadonlyMap<string, number>;
  commentsIn: ReadonlyMap<string, number>;
}

/** Comments still asking for something: everything but done and outdated. */
const OPEN: ReadonlySet<RailComment["state"]> = new Set(["unsent", "sent", "answered", "resolved"]);

export function useMarks(
  agent: AgentFiles | null,
  changes: readonly (Pick<ChangedFile, "path"> & { viewed?: boolean })[] | null | undefined,
  comments: readonly Pick<RailComment, "path" | "state">[] | null | undefined,
): Marks {
  return useMemo(() => {
    const add = (map: Map<string, number>, path: string, n = 1) => {
      for (const d of ancestors(path)) if (d) map.set(d, (map.get(d) ?? 0) + n);
    };
    const agentMap = new Map<string, AgentFile>();
    const agentIn = new Map<string, AgentFile["turn"]>();
    for (const f of agent?.files ?? []) {
      agentMap.set(f.path, f);
      for (const d of ancestors(f.path)) if (d && agentIn.get(d) !== "running") agentIn.set(d, f.turn);
    }
    const unviewed = new Set<string>();
    const unviewedIn = new Map<string, number>();
    for (const c of changes ?? [])
      if (c.viewed === false) {
        unviewed.add(c.path);
        add(unviewedIn, c.path);
      }
    const commentCount = new Map<string, number>();
    const commentsIn = new Map<string, number>();
    for (const c of comments ?? [])
      if (OPEN.has(c.state)) {
        commentCount.set(c.path, (commentCount.get(c.path) ?? 0) + 1);
        add(commentsIn, c.path);
      }
    return { agent: agentMap, agentIn, unviewed, unviewedIn, comments: commentCount, commentsIn };
  }, [agent, changes, comments]);
}

/**
 * The tree narrowed to the agent's files (`t`), under the folders that hold
 * them, shown open. Built from the paths alone, so folders never read show
 * too; a file the agent deleted shows as deleted.
 */
export function agentRows(files: readonly AgentFile[]): Row[] {
  type Node = { dirs: Map<string, Node>; files: AgentFile[] };
  const root: Node = { dirs: new Map(), files: [] };
  for (const f of files) {
    let node = root;
    for (const part of f.path.split("/").slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) node.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push(f);
  }
  const rows: Row[] = [];
  const walk = (node: Node, dir: string, depth: number) => {
    const dirs = [...node.dirs.keys()].map((name) => ({ name, kind: "dir" as const })).sort(compareEntries);
    for (const { name } of dirs) {
      const path = joinPath(dir, name);
      rows.push({ type: "entry", path, name, depth, kind: "dir", link: false, open: true, hidden: name.startsWith(".") });
      walk(node.dirs.get(name)!, path, depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => compareEntries({ name: nameOf(a.path), kind: "file" }, { name: nameOf(b.path), kind: "file" }))) {
      const name = nameOf(f.path);
      rows.push({ type: "entry", path: f.path, name, depth, kind: "file", link: false, open: false, hidden: name.startsWith("."), ...(f.change === "deleted" ? { state: "deleted" as const } : {}) });
    }
  };
  walk(root, "", 0);
  if (rows.length === 0) rows.push({ type: "note", key: "note:agent", depth: 0, tone: "muted", text: "The agent has not changed a file in this turn or the last" });
  return rows;
}

/** The ready questions of the Ask box, for what is asked about. */
export function readyQuestions(kinds: readonly ("file" | "dir")[]): string[] {
  if (kinds.length > 1) return ["How do these relate?", "What would change if I edited them together?"];
  if (kinds[0] === "dir") return ["What is in here?", "How do its parts fit together?", "Where would I start reading?"];
  return ["Explain this file", "Who uses it?", "Write its tests", "Review it"];
}
