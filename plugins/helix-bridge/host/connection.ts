// One client connection to one Helix bridge socket: newline-delimited
// JSON-RPC 2.0, request ids, per-request timeouts with `$/cancel`, and the
// protocol's 8 MiB line limit. Knows nothing about instances or bb.
import { createConnection, type Socket } from "node:net";
import { MAX_LINE_BYTES, errorName } from "../shared/protocol";

export interface RpcFailure {
  code: number;
  name: string;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  constructor(readonly failure: RpcFailure) {
    super(failure.message);
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: RpcError) => void; timer: ReturnType<typeof setTimeout> };

export interface ConnectionEvents {
  onNotification(method: string, params: unknown): void;
  onClose(error: Error | null): void;
}

export class BridgeConnection {
  private socket: Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private closed = false;

  constructor(
    readonly socketPath: string,
    private readonly events: ConnectionEvents,
  ) {}

  /** Resolves once connected; rejects with the socket error (ENOENT, ECONNREFUSED, ...). */
  connect(timeoutMs = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error(`connect timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" }));
      }, timeoutMs);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on("data", (chunk: string) => this.receive(chunk));
        socket.on("close", () => this.shutdown(null));
        socket.on("error", (error) => this.shutdown(error));
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        if (!this.socket) reject(error);
      });
    });
  }

  get connected(): boolean {
    return this.socket !== null && !this.closed;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes("\n")) {
      this.shutdown(new Error("a line from Helix exceeded 8 MiB"));
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim()) this.handle(line);
    }
  }

  private handle(line: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      return; // Helix never sends invalid JSON; ignore rather than crash
    }
    if (typeof message.method === "string" && message.id === undefined) {
      this.events.onNotification(message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return; // answered after a timeout or cancel
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const code = typeof message.error.code === "number" ? message.error.code : -32603;
      pending.reject(
        new RpcError({
          code,
          name: errorName(code) ?? "error",
          message: typeof message.error.message === "string" ? message.error.message : "error",
          ...(message.error.data === undefined ? {} : { data: message.error.data }),
        }),
      );
    } else pending.resolve(message.result);
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (!this.connected || !this.socket) return Promise.reject(new RpcError({ code: 0, name: "not_connected", message: "not connected to Helix" }));
    const id = this.nextId++;
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      const cancel = (name: string, message: string) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        if (this.connected) socket.write(JSON.stringify({ jsonrpc: "2.0", method: "$/cancel", params: { id } }) + "\n");
        reject(new RpcError({ code: name === "timeout" ? 1005 : 1008, name, message }));
      };
      const timer = setTimeout(() => cancel("timeout", `${method} did not answer in ${timeoutMs} ms`), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener("abort", () => cancel("cancelled", `${method} was cancelled`), { once: true });
      socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
    });
  }

  close(): void {
    this.shutdown(null);
  }

  private shutdown(error: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new RpcError({ code: 0, name: "not_connected", message: "the connection to Helix closed" }));
    }
    this.pending.clear();
    this.events.onClose(error);
  }
}
