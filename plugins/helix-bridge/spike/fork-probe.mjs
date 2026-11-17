#!/usr/bin/env node
// Drive a real Helix bridge socket through every step 1 method, the error
// paths and the events, and print what came back next to what PROTOCOL.md
// says. Only for an instance you started yourself.
//
//   node spike/fork-probe.mjs <registry.json> <workspace-relative file> <second file>
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

const [registryPath, fileA, fileB] = process.argv.slice(2);
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const socket = createConnection(registry.socket);
socket.setEncoding("utf8");
let buffer = "";
let nextId = 1;
const pending = new Map();
const events = [];
socket.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    const m = JSON.parse(line);
    if (m.method) events.push({ t: Date.now(), method: m.method, params: m.params });
    else pending.get(m.id)?.(m), pending.delete(m.id);
  }
});
await new Promise((r) => socket.once("connect", r));
const call = (method, params, raw) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.write((raw ?? JSON.stringify({ jsonrpc: "2.0", id, method, params })) + "\n");
    setTimeout(() => pending.has(id) && (pending.delete(id), resolve({ timeout: true })), 4000);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (label, value) => console.log(`\n## ${label}\n${JSON.stringify(value, (k, v) => (k === "text" && typeof v === "string" && v.length > 120 ? `${v.slice(0, 120)}… (${v.length})` : v), 1)}`);

const hello = await call("bridge/hello", { client: "probe", clientVersion: "0" });
show("bridge/hello", hello);
show("events/subscribe all", await call("events/subscribe", { events: ["selection", "documents", "diagnostics", "mode", "send", "lsp", "externalChange"] }));
show("events/subscribe unknown kind", await call("events/subscribe", { events: ["selection", "bogus"] }));
show("editor/state", await call("editor/state", {}));
events.length = 0;
show("editor/open relative, line 10..12 (no endCol)", await call("editor/open", { path: fileA, line: 10, endLine: 12, note: "probe: lines 10-12" }));
await sleep(300);
show("editor/selection after open", await call("editor/selection", {}));
show("events after open", events.splice(0));
show("editor/open second file in a vertical split, focus", await call("editor/open", { path: fileB, line: 3, col: 2, split: "vertical" }));
await sleep(300);
show("events after split open", events.splice(0).map((e) => e.method));
show("editor/open focus:false", await call("editor/open", { path: fileA, focus: false }));
show("editor/open interrupt bogus", await call("editor/open", { path: fileA, interrupt: "later" }));
show("editor/open missing file", await call("editor/open", { path: "nope/missing.go" }));
show("editor/open a directory", await call("editor/open", { path: "plugins" }));
show("editor/text by path, range 10:1-12:1", await call("editor/text", { path: fileA, range: { start: { line: 10, col: 1 }, end: { line: 12, col: 1 } } }));
show("editor/text unknown docId", await call("editor/text", { docId: 999999 }));
show("editor/text file not open", await call("editor/text", { path: "plugins/helix-bridge/package.json" }));
show("editor/status", await call("editor/status", { message: "probe says hi", severity: "warning" }));
show("editor/reload (step 2a)", await call("editor/reload", {}));
show("diagnostics/get limit 0 (step 2b)", await call("diagnostics/get", { limit: 0 }));
show("view/list (2c)", await call("view/list", {}));
show("unknown method", await call("editor/fly", {}));
show("params not an object", await call("editor/state", [1, 2]));
show("missing jsonrpc", await call(null, null, JSON.stringify({ id: 77, method: "editor/state" })));
show("parse error", await call(null, null, "{not json"));
// $/cancel on a request in flight.
const id = nextId++;
const cancelled = new Promise((resolve) => pending.set(id, resolve));
socket.write(JSON.stringify({ jsonrpc: "2.0", id, method: "editor/state", params: {} }) + "\n" + JSON.stringify({ jsonrpc: "2.0", method: "$/cancel", params: { id } }) + "\n");
show("$/cancel right after a request", await Promise.race([cancelled, sleep(3000).then(() => "no answer")]));
show("events/unsubscribe selection", await call("events/unsubscribe", { events: ["selection"] }));
socket.end();
