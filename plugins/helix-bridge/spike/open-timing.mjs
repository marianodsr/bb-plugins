#!/usr/bin/env node
// How long the editor takes to show Helix, and what the time is made of
// (window.__helixTimeline: session, renderer, attached, firstOutput,
// firstFrame, in ms from the surface mounting), for three cases:
//   fresh: a new page load, Helix already running;
//   warm:  back to the editor from the thread page inside bb (no reload);
//   cold:  as fresh, after closing the thread's Helix (`--cold`, which
//          closes the terminal of the thread you name: only your own).
//
//   node spike/open-timing.mjs --thread <id> --project <id> [--runs 3] [--cold]
import { execFileSync } from "node:child_process";
import { launch, SERVER, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const thread = opt("thread", "thr_n2derddyg6");
const project = opt("project", "proj_v2ia75srgp");
const runs = Number(opt("runs", "3"));
const cold = argv.includes("--cold");

async function waitTimeline(page, since) {
  for (let i = 0; i < 400; i += 1) {
    const t = await page.evaluate((id) => window.__helixTimeline?.[id] ?? null, thread);
    if (t?.firstFrame !== undefined) return { ...t, wall: Date.now() - since };
    await sleep(25);
  }
  return { timeout: true, wall: Date.now() - since };
}

const results = { fresh: [], warm: [], cold: [] };
for (let run = 0; run < runs; run += 1) {
  if (cold) {
    const list = execFileSync("bb", ["terminal", "list", "--thread", thread], { encoding: "utf8" });
    const id = list.split("\n").find((l) => /\bHelix\b/u.test(l))?.split(/\s+/u)[0];
    if (id) execFileSync("bb", ["terminal", "close", id]);
    await sleep(1500);
  }
  const { browser, page } = await launch({ width: 1440, height: 900, theme: "dark" });
  try {
    let since = Date.now();
    await page.goto(`${SERVER}/plugins/helix-bridge/editor/${thread}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    results[cold ? "cold" : "fresh"].push(await waitTimeline(page, since));
    if (!cold) {
      // Warm: to the thread and back through bb's own navigation.
      await page.evaluate((url) => {
        history.pushState({}, "", url);
        dispatchEvent(new PopStateEvent("popstate"));
      }, `/projects/${project}/threads/${thread}`);
      await sleep(1500);
      await page.evaluate((id) => delete window.__helixTimeline?.[id], thread);
      since = Date.now();
      await page.evaluate((url) => {
        history.pushState({}, "", url);
        dispatchEvent(new PopStateEvent("popstate"));
      }, `/plugins/helix-bridge/editor/${thread}`);
      results.warm.push(await waitTimeline(page, since));
    }
  } finally {
    await browser.close();
  }
}
for (const [kind, list] of Object.entries(results)) {
  if (list.length === 0) continue;
  console.log(kind);
  for (const r of list) console.log("  " + JSON.stringify(r));
}
