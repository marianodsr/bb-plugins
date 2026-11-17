// Helix Bridge host entry. Runs on the machine where Helix runs (bb's host
// RPC worker) and owns every bridge socket; the server never touches them.
//
// The worker is lazy: the first call starts an InstanceManager for the bridge
// directory and keeps the call context's signal emitter for later events. A
// worker lease holds the worker while any instance is connected.
import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./shared/host-contract";
import { readGhosttyConfig, runDoctor } from "./host/doctor";
import { InstanceManager, defaultBridgeDir } from "./host/manager";

type Context = ExperimentalHostRpcContext<typeof hostSignals>;

let manager: InstanceManager | null = null;
let emit: Context["experimental_emitSignal"] | null = null;

/** The manager for `bridgeDir` (empty: Helix's default; null: whichever is running). */
function managerFor(bridgeDir: string | undefined | null, context: Context): InstanceManager {
  emit = context.experimental_emitSignal.bind(context);
  if (bridgeDir === null && manager) return manager;
  const dir = bridgeDir?.trim() ? bridgeDir.trim() : defaultBridgeDir();
  if (manager && manager.bridgeDir === dir) return manager;
  manager?.dispose();
  const created = new InstanceManager(dir, {
    emitState: (payload) => {
      void emit?.("state", payload).catch(() => {});
    },
    retain: () => {
      const lease = context.experimental_retainWorker();
      return () => void lease.dispose();
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
  return created;
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
    ghosttyConfig: () => readGhosttyConfig(),
  },
  dispose: () => {
    manager?.dispose();
    manager = null;
  },
});

export default entry;
