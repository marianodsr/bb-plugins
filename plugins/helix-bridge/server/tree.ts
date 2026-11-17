// The file tree beside the editor: yazi in its own thread-scoped bb terminal
// session ("Files"), started in the thread's workspace on its machine with a
// configuration layered on the user's (host/yazi.ts). Choosing a file runs
// `bb hx tree-open`, which opens it in the Helix serving the thread; the app
// asks for `reveal` when Helix's focused file changes.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HelixService } from "./service";

type Sdk = BbPluginApi["sdk"];

export const TREE_TITLE = "Files";

export interface TreeDeps {
  sdk(): Sdk;
  service: HelixService;
  hostCall(method: "yaziPrepare" | "yaziEmit", input: unknown, hostId: string): Promise<unknown>;
  /** The bridge directory setting; empty follows Helix's cache directory. */
  bridgeDir(): Promise<string>;
}

interface YaziSetup {
  yazi: string | null;
  ya: string | null;
  configDir: string | null;
  opener?: string | null;
}

/** A stable yazi client id per thread (yazi wants a globally unique number). */
export function treeClientId(threadId: string): string {
  return String(parseInt(createHash("sha1").update(`helix-bridge-tree:${threadId}`).digest("hex").slice(0, 12), 16));
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./~=-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}

export type TreeTerminal = { terminalId: string; created: boolean; missing: null } | { terminalId: null; created: false; missing: string };

export class Tree {
  private readonly opening = new Map<string, Promise<TreeTerminal>>();

  constructor(private readonly deps: TreeDeps) {}

  private async running(threadId: string) {
    const { sessions } = await this.deps.sdk().terminals.list({ scope: { kind: "thread", threadId } });
    return sessions.find((t) => t.title === TREE_TITLE && (t.status === "running" || t.status === "starting")) ?? null;
  }

  /** The thread's tree session, started on first use. One per thread; concurrent opens share one call. */
  terminal(threadId: string): Promise<TreeTerminal> {
    const pending = this.opening.get(threadId);
    if (pending) return pending;
    const work = (async (): Promise<TreeTerminal> => {
      const existing = await this.running(threadId);
      if (existing) return { terminalId: existing.id, created: false, missing: null };
      const info = await this.deps.service.threadInfo(threadId);
      if (!info.hostId || !info.path) return { terminalId: null, created: false, missing: "This thread has no workspace to show." };
      const setup = (await this.deps.hostCall("yaziPrepare", {}, info.hostId)) as YaziSetup;
      if (!setup.yazi || !setup.configDir) return { terminalId: null, created: false, missing: process.platform === "darwin" ? "brew install yazi" : "Install yazi: https://yazi-rs.github.io/docs/installation" };
      const opener = setup.opener ?? join(setup.configDir, "helix-open");
      const bridgeDir = (await this.deps.bridgeDir()).trim();
      // The opener talks to Helix's socket; yazi's own `edit` opener runs
      // $EDITOR when the user's yazi.toml keeps it, so that is the same script.
      const vars = [`BB_THREAD_ID=${threadId}`, `YAZI_CONFIG_HOME=${setup.configDir}`, `HELIX_BRIDGE_OPEN=${opener}`, `EDITOR=${opener}`, ...(bridgeDir ? [`HELIX_BRIDGE_DIR=${bridgeDir}`] : [])];
      const command = `${vars.map(shellQuote).join(" ")} exec ${shellQuote(setup.yazi)} --client-id ${treeClientId(threadId)} ${shellQuote(info.path)}`;
      const created = await this.deps.sdk().terminals.create({ scope: { kind: "thread", threadId }, title: TREE_TITLE, cols: 30, rows: 48, start: { mode: "command", command } });
      return { terminalId: created.id, created: true, missing: null };
    })().finally(() => this.opening.delete(threadId));
    this.opening.set(threadId, work);
    return work;
  }

  /** Show `path` in the tree (it moves there and hovers it). */
  async reveal(threadId: string, path: string): Promise<boolean> {
    if (!(await this.running(threadId))) return false;
    const info = await this.deps.service.threadInfo(threadId);
    if (!info.hostId) return false;
    const result = (await this.deps.hostCall("yaziEmit", { clientId: treeClientId(threadId), name: "reveal", args: [path] }, info.hostId)) as { ok: boolean };
    return result.ok;
  }

  /** Close the thread's tree (the editor closed). */
  async close(threadId: string): Promise<boolean> {
    const existing = await this.running(threadId);
    if (!existing) return false;
    await this.deps.sdk().terminals.close({ terminalId: existing.id, mode: "force" });
    return true;
  }
}
