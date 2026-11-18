// Helix Bridge host entry. Runs on the machine where Helix runs (bb's host
// RPC worker) and owns every bridge socket; the server never touches them.
//
// The worker is lazy: the first call starts an InstanceManager for the bridge
// directory and keeps the call context's signal emitter for later events. A
// worker lease holds the worker while any instance is connected; leases can
// only be taken inside a call, so every call syncs it (the server reconciles
// every 30 s, well inside the 5-minute idle window).
import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./shared/host-contract";
import { readGhosttyConfig, resolveExecutable, resolveFaces, runDoctor } from "./host/doctor";
import { prepareYazi, yaEmit } from "./host/yazi";
import { recentCommits, revParse, subject } from "./host/git";
import { applyOp, checkPaths, listDirs } from "./host/files";
import { InstanceManager, defaultBridgeDir } from "./host/manager";

type Context = ExperimentalHostRpcContext<typeof hostSignals>;

let manager: InstanceManager | null = null;
let emit: Context["experimental_emitSignal"] | null = null;
let lease: { dispose(): Promise<void> } | null = null;

function dropLease(): void {
  void lease?.dispose();
  lease = null;
}

/** Take the worker lease inside an active call when the manager wants one. */
function syncLease(context: Context): void {
  if (manager?.leaseWanted && !lease) lease = context.experimental_retainWorker();
  else if (!manager?.leaseWanted && lease) dropLease();
}

/** The manager for `bridgeDir` (empty: Helix's default; null: whichever is running). */
function managerFor(bridgeDir: string | undefined | null, context: Context): InstanceManager {
  emit = context.experimental_emitSignal.bind(context);
  if (bridgeDir === null && manager) return withLease(manager, context);
  const dir = bridgeDir?.trim() ? bridgeDir.trim() : defaultBridgeDir();
  if (manager && manager.bridgeDir === dir) return withLease(manager, context);
  manager?.dispose();
  const created = new InstanceManager(dir, {
    emitState: (payload) => {
      void emit?.("state", payload).catch(() => {});
    },
    leaseWanted: (wanted) => {
      if (!wanted) dropLease();
    },
    watch: async (path, onChange) => {
      const subscription = await context.experimental_watch({ rootPath: path, debounceMs: 50, maxWaitMs: 300 }, () => onChange());
      return () => void subscription.dispose();
    },
    log: (message) => console.error(`[helix-bridge host] ${message}`),
  });
  manager = created;
  context.lifecycle.signal.addEventListener("abort", () => created.dispose(), { once: true });
  created.start();
  return withLease(created, context);
}

function withLease(current: InstanceManager, context: Context): InstanceManager {
  syncLease(context);
  return current;
}

const entry = experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    instances: ({ bridgeDir }, context) => {
      const current = managerFor(bridgeDir, context);
      current.scan();
      return { bridgeDir: current.bridgeDir, dirExists: current.dirExists, instances: current.list() };
    },
    call: ({ bridgeDir, instanceId, method, params, timeoutMs }, context) =>
      managerFor(bridgeDir, context).call(instanceId, method, params, timeoutMs ?? 2500, context.signal),
    pendingSends: (_input, context) => ({ sends: managerFor(null, context).pendingSends() }),
    ackSends: ({ ids }, context) => ({ remaining: managerFor(null, context).ackSends(ids) }),
    doctor: async ({ bridgeDir, hxbPath, fontFamily }, context) => {
      const current = managerFor(bridgeDir, context);
      return runDoctor({ bridgeDir: current.bridgeDir, hxbPath, fontFamily, instances: current.list() });
    },
    perfMode: async ({ instanceId, mode }, context) => ({ found: await managerFor(null, context).setPerfMode(instanceId, mode) }),
    gitRead: async ({ cwd, op, rev }) => {
      try {
        switch (op) {
          case "revParse":
            return { sha: rev ? await revParse(cwd, rev) : null, error: null };
          case "subject":
            return { subject: rev ? await subject(cwd, rev) : "", error: null };
          case "recentCommits":
            return { commits: await recentCommits(cwd), error: null };
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    yaziPrepare: (_input, context) => prepareYazi(context.experimental_paths.dataDir),
    yaziEmit: async ({ clientId, name, args }) => {
      const ya = resolveExecutable("ya");
      if (!ya) return { ok: false, error: "ya is not on PATH" };
      return yaEmit(ya, clientId, name, args).then(
        () => ({ ok: true, error: null }),
        (error: unknown) => ({ ok: false, error: String(error) }),
      );
    },
    filesList: ({ root, dirs }) => listDirs(root, dirs),
    filesOp: ({ root, op }) => applyOp(root, op),
    filesCheck: ({ root, paths, intent }) => checkPaths(root, paths, intent),
    ghosttyConfig: async ({ fontFamily, fontStyle }) => {
      const config = readGhosttyConfig();
      const effective = { ...config, ...(fontFamily ? { fontFamily } : {}), ...(fontStyle ? { fontStyle } : {}) };
      return { ...effective, faces: await resolveFaces(effective) };
    },
  },
  dispose: () => {
    manager?.dispose();
    manager = null;
    dropLease();
  },
});

export default entry;
