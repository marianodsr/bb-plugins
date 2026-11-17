#!/usr/bin/env node
// Terminal spike: a key-echo program for bb's own terminal.
//
// Puts the tty in raw mode, turns on SGR mouse reporting, bracketed paste and
// focus events, then logs every chunk it reads as JSON lines (time, hex,
// decoded) to $KEYECHO_LOG. For every chunk it paints one marker line,
// `ACK <n>`, so a driver can measure key-to-paint latency against the log.
// Also logs TERM, COLORTERM and every resize, and draws a true-colour ramp.
//
//   KEYECHO_LOG=/path/log.jsonl node spike/keyecho.mjs
//   q three times in a row quits.
import { appendFileSync, writeFileSync } from "node:fs";

const log = process.env.KEYECHO_LOG ?? "/tmp/keyecho.jsonl";
writeFileSync(log, "");
const out = (s) => process.stdout.write(s);
const record = (entry) => appendFileSync(log, JSON.stringify({ t: Date.now(), ...entry }) + "\n");

function decode(buf) {
  const s = buf.toString("latin1");
  return [...s]
    .map((c) => {
      const code = c.charCodeAt(0);
      if (code === 0x1b) return "ESC";
      if (code < 0x20) return `^${String.fromCharCode(code + 64)}`;
      if (code === 0x7f) return "DEL";
      if (code > 0x7e) return `\\x${code.toString(16)}`;
      return c;
    })
    .join(" ");
}

function ramp() {
  let line = "";
  for (let i = 0; i < 64; i++) {
    const r = Math.round((i / 63) * 255);
    line += `\x1b[48;2;${r};${255 - r};128m `;
  }
  return line + "\x1b[0m";
}

record({ kind: "start", term: process.env.TERM ?? null, colorterm: process.env.COLORTERM ?? null, cols: process.stdout.columns, rows: process.stdout.rows, termProgram: process.env.TERM_PROGRAM ?? null });

process.stdin.setRawMode(true);
process.stdin.resume();
// 1000 press/release, 1002 drag, 1006 SGR coordinates, 2004 bracketed paste, 1004 focus.
out("\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h");
out("\x1b[2J\x1b[H");
out(`keyecho  TERM=${process.env.TERM} COLORTERM=${process.env.COLORTERM ?? "-"} ${process.stdout.columns}x${process.stdout.rows}\r\n`);
out(ramp() + "\r\n");
if (process.env.KEYECHO_KITTY === "1") out("\x1b[>1u\x1b[?u"); // push disambiguate, then query
out("READY\r\n");
record({ kind: "ready" });

process.stdout.on("resize", () => {
  record({ kind: "resize", cols: process.stdout.columns, rows: process.stdout.rows });
  out(`RESIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`);
});

let n = 0;
let qs = 0;
process.stdin.on("data", (buf) => {
  n += 1;
  record({ kind: "input", n, hex: buf.toString("hex"), decoded: decode(buf), bytes: buf.length });
  out(`ACK ${n} ${decode(buf).slice(0, 60)}\r\n`);
  // "%" asks for an OSC 52 clipboard write, to see which renderers honour it.
  if (buf.toString() === "%") out(`\x1b]52;c;${Buffer.from("spike-osc52").toString("base64")}\x07`);
  qs = buf.toString() === "q" ? qs + 1 : 0;
  if (qs >= 3) {
    out("\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?1004l");
    process.exit(0);
  }
});
