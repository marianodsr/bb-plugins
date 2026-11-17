#!/usr/bin/env node
// Key-to-first-output through bb's terminal path (server, daemon, PTY), no
// browser: one thread-scoped terminal per program, attached over
// /ws/terminals/<id>, a burst of `j` then `k` per round, programs interleaved
// in rotating order. Closes its terminals afterwards.
//
//   node spike/rtt.mjs [--thread <id>] [--rounds 6] [--keys 40] [--gap 50]
import { execFileSync } from "node:child_process";
import { SERVER, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const thread = opt("thread", "thr_fh7kmixkaj");
const rounds = Number(opt("rounds", "6"));
const keys = Number(opt("keys", "40"));
const gap = Number(opt("gap", "50"));
const storage = `/Users/marianodsr/.bb/thread-storage/${thread}/spike`;
const hxb = "/Users/marianodsr/projects/helix-bb/try/hxb";
const file = opt("file", `${storage}/server.go`);
const throwaway = `XDG_CONFIG_HOME=${storage}/xdg-config XDG_CACHE_HOME=${storage}/xdg-cache-rtt`;
const programs = {
  echo: `stty raw -echo; exec cat`,
  hx: `env ${throwaway} hx ${file}`,
  hxb: `env ${throwaway} ${hxb} ${file}`,
  "hxb-owner-config": `exec ${hxb} ${file}`,
  // Same, but the file is opened with :o after Helix started (as on the editor page).
  "hxb-open-later": `env ${throwaway} ${hxb}`,
  "hx-open-later": `env ${throwaway} hx`,
  "hxb-owner-open-later": `env XDG_CACHE_HOME=${storage}/xdg-cache-rtt ${hxb}`,
  // The fork's binary on a runtime copy whose Go injections are empty.
  "hxb-no-go-injections": `env ${throwaway} HELIX_RUNTIME=${storage}/rt-noinj /Users/marianodsr/projects/helix-bb/try/hx ${file}`,
};
const only = argv.includes("--attach") ? ["attached", ...opt("programs", "hx").split(",")] : opt("programs", Object.keys(programs).join(",")).split(",");
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null;
};
const b64 = (s) => Buffer.from(s).toString("base64");

const attachTo = opt("attach", null);
async function open(name) {
  const created = name === "attached" ? { id: attachTo } : JSON.parse(
    execFileSync("bb", ["terminal", "create", "--thread", thread, "--title", `rtt ${name}`, "--cols", "140", "--rows", "47", "--json", "--command", programs[name]], { encoding: "utf8" }),
  );
  const ws = new WebSocket(`${SERVER.replace(/^http/u, "ws")}/ws/terminals/${created.id}`);
  const t = { name, id: created.id, ws, waiting: null, samples: [] };
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === "output" && t.waiting !== null) {
      t.samples.push(performance.now() - t.waiting);
      t.waiting = null;
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  if (name !== "attached") ws.send(JSON.stringify({ type: "resize", cols: 140, rows: 47 }));
  return t;
}

const terms = [];
try {
  for (const name of only) terms.push(await open(name));
  await sleep(2500);
  for (const t of terms.filter((t) => t.name.endsWith("-open-later"))) t.ws.send(JSON.stringify({ type: "input", dataBase64: b64(`:o ${file}\r`) }));
  await sleep(2500);
  const all = Object.fromEntries(only.map((n) => [n, []]));
  for (let r = 0; r < rounds; r += 1) {
    const order = terms.map((_, i) => terms[(i + r) % terms.length]);
    for (const t of order) {
      t.samples = [];
      const k = r % 2 === 0 ? "j" : "k";
      for (let i = 0; i < keys; i += 1) {
        // The next key waits for the previous one's output (up to 500 ms).
        for (let w = 0; t.waiting !== null && w < 100; w += 1) await sleep(5);
        t.waiting = performance.now();
        t.ws.send(JSON.stringify({ type: "input", dataBase64: b64(k) }));
        await sleep(gap);
      }
      t.waiting = null;
      await sleep(300);
      all[t.name].push(...t.samples);
      console.log(JSON.stringify({ round: r, program: t.name, n: t.samples.length, p50: pct(t.samples, 0.5), p95: pct(t.samples, 0.95) }));
    }
  }
  console.log("program\tn\tp50\tp95\tmax");
  for (const n of only) console.log(`${n}\t${all[n].length}\t${pct(all[n], 0.5)}\t${pct(all[n], 0.95)}\t${pct(all[n], 1)}`);
} finally {
  for (const t of terms) {
    t.ws.close();
    if (t.name === "attached") continue;
    try {
      execFileSync("bb", ["terminal", "close", t.id], { encoding: "utf8" });
    } catch {}
  }
}
