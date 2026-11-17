#!/usr/bin/env node
// Interleaved key-to-paint A/B on one real session and file: rounds of
// `bb hx perf-mode off | quiet | normal --instance <ours>` in rotating order, each a burst of
// cursor moves. Needs the `hud` setting on and a Helix started by the editor
// page for your own thread (refuses otherwise). Restores `normal`.
//
//   node spike/ab.mjs --thread <threadId> [--file <path>] [--rounds 8] [--keys 40] [--gap 50]
import { execFileSync } from "node:child_process";
import { launch, SERVER, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const thread = opt("thread", "thr_fh7kmixkaj");
const file = opt("file", "plugins/helix-bridge/server.ts");
const rounds = Number(opt("rounds", "8"));
const keys = Number(opt("keys", "40"));
const gap = Number(opt("gap", "50"));
const modes = (opt("modes", "off,quiet,normal")).split(",");
const bb = (...args) => execFileSync("bb", args, { encoding: "utf8" });
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null;
};

const { browser, page } = await launch({ width: 1440, height: 900, theme: "dark" });
const samples = Object.fromEntries(modes.map((m) => [m, []]));
const outputs = Object.fromEntries(modes.map((m) => [m, []]));
const perRound = [];
let pid = null;
try {
  await page.goto(`${SERVER}/plugins/helix-bridge/editor/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForSelector("[data-helix-hud]", { timeout: 30000 });
  await sleep(3000);
  const ours = bb("hx", "list").split("\n").find((l) => l.includes(`-> ${thread}`) && /\((terminal|explicit)\)/u.test(l));
  if (!ours) throw new Error(`no Helix bound to ${thread}`);
  console.log(ours.trim());
  pid = /pid (\d+)/u.exec(ours)[1];
  await page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
  await page.keyboard.press("Escape");
  await page.keyboard.type(`:o ${file}`);
  await page.keyboard.press("Enter");
  await sleep(1500);
  console.log(`focused: ${/focused: (.*)/u.exec(bb("hx", "state", "--instance", pid))?.[1]}`);
  await page.keyboard.type("gg");
  await sleep(500);
  for (let r = 0; r < rounds; r += 1) {
    const order = modes.map((_, i) => modes[(i + r) % modes.length]);
    for (const mode of order) {
      bb("hx", "perf-mode", mode, "--instance", pid);
      await sleep(800);
      await page.evaluate(() => window.__helixHud.reset());
      const k = r % 2 === 0 ? "j" : "k";
      for (let i = 0; i < keys; i += 1) {
        await page.keyboard.press(k);
        await sleep(gap);
      }
      await sleep(400);
      const got = await page.evaluate(() => window.__helixHud.samples());
      samples[mode].push(...got);
      outputs[mode].push(...(await page.evaluate(() => window.__helixHud.outputSamples())));
      perRound.push({ round: r, mode, n: got.length, p50: pct(got, 0.5), p95: pct(got, 0.95) });
    }
  }
} finally {
  try {
    if (pid) bb("hx", "perf-mode", "normal", "--instance", pid);
  } catch {}
  await browser.close();
}
for (const row of perRound) console.log(JSON.stringify(row));
console.log("mode\tn\tpaint p50\tpaint p95\tmax\toutput p50\toutput p95");
for (const m of modes) console.log(`${m}\t${samples[m].length}\t${pct(samples[m], 0.5)}\t${pct(samples[m], 0.95)}\t${pct(samples[m], 1)}\t${pct(outputs[m], 0.5)}\t${pct(outputs[m], 0.95)}`);
