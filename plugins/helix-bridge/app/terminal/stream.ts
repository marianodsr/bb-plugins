// Attach to a bb terminal session's own stream, the socket bb's terminal tab
// uses: `/ws/terminals/<id>`. The server first replays scrollback, then sends
// `attached { nextSeq }` and live output; chunks carry a sequence number so
// replay and live output can be merged without gaps or repeats. Input and
// resize go back as JSON messages. The SDK (0.6.132) has no attach API, so
// this is the one place that knows the wire shape.

export interface TerminalChunk {
  seq: number;
  bytes: Uint8Array;
}

type ServerMessage = { type: "attached"; nextSeq: number } | { type: "output"; seq: number; dataBase64: string };

function parse(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "attached" && Number.isSafeInteger(record.nextSeq)) {
    return { type: "attached", nextSeq: Number(record.nextSeq) };
  }
  const chunk = record.chunk as Record<string, unknown> | undefined;
  if (record.type === "output" && chunk && Number.isSafeInteger(chunk.seq) && typeof chunk.dataBase64 === "string") {
    return { type: "output", seq: Number(chunk.seq), dataBase64: chunk.dataBase64 };
  }
  return null;
}

export function decodeBase64(value: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (input: string) => Uint8Array }).fromBase64;
  if (native) return native(value);
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  const native = bytes as Uint8Array & { toBase64?: () => string };
  if (typeof native.toBase64 === "function") return native.toBase64();
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

const encoder = new TextEncoder();

export interface TerminalStreamEvents {
  onChunk(chunk: TerminalChunk): void;
  onState?(state: "connecting" | "open" | "closed"): void;
}

export class TerminalStream {
  private socket: WebSocket | null = null;
  private lastSeq = -1;
  private nextSeq: number | null = null;
  private held: TerminalChunk[] = [];
  private queued: string[] = [];
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private size: { cols: number; rows: number } | null = null;

  constructor(
    readonly terminalId: string,
    private readonly events: TerminalStreamEvents,
  ) {}

  connect(): void {
    if (this.closed || this.socket) return;
    this.events.onState?.("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/terminals/${encodeURIComponent(this.terminalId)}`);
    this.socket = socket;
    this.nextSeq = null;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.retry = 0;
      this.events.onState?.("open");
      if (this.size) socket.send(JSON.stringify({ type: "resize", ...this.size }));
      for (const message of this.queued.splice(0)) socket.send(message);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.events.onState?.("closed");
      if (this.closed) return;
      const delay = this.retry === 0 ? 0 : Math.min(2000, 100 * 2 ** this.retry);
      this.retry += 1;
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  private receive(raw: unknown): void {
    const message = parse(raw);
    if (!message) return;
    if (message.type === "attached") {
      this.nextSeq = message.nextSeq;
      const held = this.held.splice(0).sort((a, b) => a.seq - b.seq);
      for (const chunk of held) this.deliver(chunk);
      return;
    }
    const chunk = { seq: message.seq, bytes: decodeBase64(message.dataBase64) };
    // Before `attached`, replay and live output can interleave; hold and sort.
    if (this.nextSeq === null) this.held.push(chunk);
    else this.deliver(chunk);
  }

  private deliver(chunk: TerminalChunk): void {
    if (chunk.seq <= this.lastSeq) return;
    this.lastSeq = chunk.seq;
    this.events.onChunk(chunk);
  }

  private send(message: string): void {
    if (this.closed) return;
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
    else {
      this.queued.push(message);
      this.connect();
    }
  }

  input(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    if (bytes.length > 0) this.send(JSON.stringify({ type: "input", dataBase64: encodeBase64(bytes) }));
  }

  resize(cols: number, rows: number): void {
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) return;
    if (this.size && this.size.cols === cols && this.size.rows === rows) return;
    this.size = { cols, rows };
    this.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
    }
  }
}
