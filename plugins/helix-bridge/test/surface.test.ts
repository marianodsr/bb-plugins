// When the editor process ends, the surface closes (clean exit, or closed
// from bb's side) or reports (non-zero exit, crash); a running session that
// a reloaded window re-attaches to stays open.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalStream, exitOutcome, type TerminalSessionInfo } from "../app/terminal/stream";
import { lastLines } from "../app/surface/EditorSurface";

class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const session = (over: Partial<TerminalSessionInfo> & Record<string, unknown>) => ({ id: "term_x", status: "running", exitCode: null, closeReason: null, ...over });

beforeEach(() => {
  (globalThis as Record<string, unknown>).WebSocket = FakeSocket;
  (globalThis as Record<string, unknown>).location = { protocol: "http:", host: "127.0.0.1:38886" };
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).WebSocket;
  delete (globalThis as Record<string, unknown>).location;
});

function attach() {
  const seen: TerminalSessionInfo[] = [];
  const output: string[] = [];
  const stream = new TerminalStream("term_x", {
    onChunk: (c) => output.push(new TextDecoder().decode(c.bytes)),
    onSession: (s) => seen.push(s),
  });
  stream.connect();
  const socket = FakeSocket.last!;
  socket.onopen?.();
  return { stream, socket, seen, output };
}

describe("editor exit", () => {
  it("closes the surface on a clean exit", () => {
    const { socket, seen } = attach();
    socket.receive({ type: "attached", nextSeq: 0, session: session({}) });
    socket.receive({ type: "exited", session: session({ status: "exited", exitCode: 0, closeReason: "process-exit" }) });
    expect(seen.map(exitOutcome)).toEqual([null, "close"]);
  });

  it("reports a non-zero exit or a crash", () => {
    const { socket, seen } = attach();
    socket.receive({ type: "exited", session: session({ status: "exited", exitCode: 101, closeReason: "process-exit" }) });
    expect(exitOutcome(seen[0]!)).toBe("report");
    expect(exitOutcome({ status: "exited", exitCode: null, closeReason: "daemon-disconnect" })).toBe("report");
  });

  it("closes the surface when bb closed the terminal", () => {
    const { socket, seen } = attach();
    socket.receive({ type: "exited", session: session({ status: "exited", exitCode: 0, closeReason: "user" }) });
    expect(exitOutcome(seen[0]!)).toBe("close");
    expect(exitOutcome({ status: "exited", exitCode: 143, closeReason: "user" })).toBe("close");
  });

  it("re-attaches after a window reload while Helix runs, replaying its screen", () => {
    const { socket, seen, output } = attach();
    socket.receive({ type: "output", chunk: { seq: 0, dataBase64: btoa("replayed") } });
    socket.receive({ type: "attached", nextSeq: 1, session: session({}) });
    socket.receive({ type: "output", chunk: { seq: 1, dataBase64: btoa(" live") } });
    expect(seen.map(exitOutcome)).toEqual([null]);
    expect(output.join("")).toBe("replayed live");
  });

  it("notices on attach that Helix ended while no surface was open", () => {
    const { socket, seen } = attach();
    socket.receive({ type: "attached", nextSeq: 3, session: session({ status: "exited", exitCode: 2, closeReason: "process-exit" }) });
    expect(exitOutcome(seen[0]!)).toBe("report");
  });

  it("keeps the last printed lines without escape sequences", () => {
    const text = "\x1b[2J\x1b[Hline 1\r\n\x1b[31mpanicked at src/main.rs\x1b[0m\r\nnote: run with RUST_BACKTRACE=1\r\n";
    expect(lastLines(text)).toBe("line 1\npanicked at src/main.rs\nnote: run with RUST_BACKTRACE=1");
    expect(lastLines(Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n"), 3)).toBe("l27\nl28\nl29");
  });
});
