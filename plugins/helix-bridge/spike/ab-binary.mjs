#!/usr/bin/env node
// Stock hx against the fork in the shipped surface, interleaved by block:
// each block replaces this thread's "Helix" terminal (the editor page reuses
// a running one) with one binary, same throwaway config and file, then
// reloads the page and measures a burst of cursor moves through the HUD.
// Only touches terminals of your own thread. Needs the `hud` setting on.
//
//   node spike/ab-binary.mjs [--thread <id>] [--file <path>] [--rounds 4] [--keys 60] [--gap 50]
import { execFileSync } from "node:child_process";
import { launch, SERVER, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const thread = opt("thread", "thr_fh7kmixkaj");
const storage = `/Users/marianodsr/.bb/thread-storage/${thread}/spike`;
const file = opt("file", `${storage}/server.go`);
const rounds = Number(opt("rounds", "4"));
const keys = Number(opt("keys", "60"));
const gap = Number(opt("gap", "50"));
const config = `XDG_CONFIG_HOME=${storage}/xdg-config`;
const programs = {
  hx: `env ${config} XDG_CACHE_HOME=${storage}/xdg-cache-rtt hx ${file}`,
  // Default cache directory, so the plugin connects to it as usual.
  hxb: `env ${config} /Users/marianodsr/projects/helix-bb/try/hxb ${file}`,
};
const bb = (...args) => execFileSync("bb", args, { encoding: "utf8" });
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null;
};
const helixTerminals = () => JSON.parse(bb("terminal", "list", "--thread", thread, "--json")).sessions.filter((t) => t.title === "Helix" && t.status === "running");
const closeHelix = () => {
  for (const t of helixTerminals()) bb("terminal", "close", t.id);
};

const { browser, page } = await launch({ width: 1440, height: 900, theme: "dark" });
const paint = { hx: [], hxb: [] };
const output = { hx: [], hxb: [] };
try {
  for (let r = 0; r < rounds; r += 1) {
    for (const name of r % 2 === 0 ? ["hx", "hxb"] : ["hxb", "hx"]) {
      closeHelix();
      bb("terminal", "create", "--thread", thread, "--title", "Helix", "--cols", "140", "--rows", "47", "--command", programs[name]);
      await page.goto(`${SERVER}/plugins/helix-bridge/editor/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
      await page.waitForSelector("[data-helix-hud]", { timeout: 30000 });
      await sleep(3000);
      await page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
      await page.evaluate(() => window.__helixHud.reset());
      for (let i = 0; i < keys; i += 1) {
        await page.keyboard.press(i < keys / 2 ? "j" : "k");
        await sleep(gap);
      }
      await sleep(400);
      const got = await page.evaluate(() => [window.__helixHud.samples(), window.__helixHud.outputSamples()]);
      paint[name].push(...got[0]);
      output[name].push(...got[1]);
      console.log(JSON.stringify({ round: r, program: name, n: got[0].length, p50: pct(got[0], 0.5), p95: pct(got[0], 0.95) }));
    }
  }
} finally {
  await browser.close();
  closeHelix();
}
console.log("program\tn\tpaint p50\tpaint p95\tmax\toutput p50\toutput p95");
for (const n of ["hx", "hxb"]) console.log(`${n}\t${paint[n].length}\t${pct(paint[n], 0.5)}\t${pct(paint[n], 0.95)}\t${pct(paint[n], 1)}\t${pct(output[n], 0.5)}\t${pct(output[n], 0.95)}`);
