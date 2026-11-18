// A ThreadLink in memory, for the `~files` preview and the tests: it records
// what was mentioned, asked and asked to be written; a file asked for appears
// in the workspace a moment later; and a fake turn edits a few files over
// some seconds, so the agent's trail can be seen moving.
import type { MemorySource } from "./memorySource";
import type { AgentFile, AgentFiles, Sent, ThreadLink } from "./types";

export interface MemoryLink extends ThreadLink {
  mentioned: string[][];
  asked: { paths: string[]; text: string }[];
  written: { path: string; description: string }[];
  /** Start a turn: each step touches files, `stepMs` apart; then the turn ends and its files are the last turn's. */
  turn(steps: { path: string; change: AgentFile["change"] }[][], stepMs: number): Promise<void>;
  /** Set the agent's files outright. */
  setAgent(files: AgentFiles): void;
  /** The next call of this kind fails with this error. */
  failNext(kind: "mention" | "ask" | "write", error: string): void;
}

export function memoryLink(source: MemorySource, options: { title?: string; writeMs?: number; newThread?: boolean } = {}): MemoryLink {
  let agent: AgentFiles = { running: false, files: [] };
  const listeners = new Set<() => void>();
  const failures = new Map<string, string>();
  const changed = () => listeners.forEach((l) => l());
  const sent = (kind: string): Sent => {
    const error = failures.get(kind);
    failures.delete(kind);
    return error ? { ok: false, error } : { ok: true, error: null };
  };
  const link: MemoryLink = {
    thread: { id: "thr_preview", title: options.title ?? "Split session errors" },
    mentioned: [],
    asked: [],
    written: [],
    async mention(paths) {
      const result = sent("mention");
      if (result.ok) link.mentioned.push([...paths]);
      return result;
    },
    async ask(paths, text) {
      const result = sent("ask");
      if (result.ok) link.asked.push({ paths: [...paths], text });
      return result;
    },
    async write(path, description) {
      const result = sent("write");
      if (!result.ok) return result;
      link.written.push({ path, description });
      // The agent writes it a moment later, and the end of its turn says so.
      setTimeout(() => {
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        source.external({ kind: "create", path }, [parent]);
        link.setAgent({ running: false, files: [...agent.files.filter((f) => f.path !== path), { path, change: "created", turn: "last" }] });
      }, options.writeMs ?? 1200);
      return result;
    },
    async agentFiles() {
      return agent;
    },
    onAgentFiles(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...(options.newThread === false ? {} : { newThread: (paths: string[]) => void link.mentioned.push(["new-thread", ...paths]) }),
    async turn(steps, stepMs) {
      // The turn before becomes "last"; this one is "running".
      const touched = new Map<string, AgentFile>();
      agent = { running: true, files: agent.files.map((f) => ({ ...f, turn: "last" as const })) };
      changed();
      for (const step of steps) {
        await new Promise((r) => setTimeout(r, stepMs));
        for (const f of step) {
          touched.set(f.path, { ...f, turn: "running" });
          if (f.change === "created" && !source.exists(f.path)) source.external({ kind: "create", path: f.path });
        }
        agent = { running: true, files: [...agent.files.filter((f) => !touched.has(f.path)), ...touched.values()] };
        changed();
      }
      await new Promise((r) => setTimeout(r, stepMs));
      agent = { running: false, files: [...touched.values()].map((f) => ({ ...f, turn: "last" as const })) };
      changed();
    },
    setAgent(files) {
      agent = files;
      changed();
    },
    failNext(kind, error) {
      failures.set(kind, error);
    },
  };
  return link;
}
