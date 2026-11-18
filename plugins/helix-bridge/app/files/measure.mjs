#!/usr/bin/env node
// Measures the file tree in the `~files` preview, in a private headless Chrome
// (run from the repository root, with the plugin built and loaded in bb, and
// outside the agent sandbox, like kit/scripts/shoot.mjs):
//
//   node plugins/helix-bridge/app/files/measure.mjs
//
// - key to painted frame for `j`, with the 5 000 entry folder open;
// - the rail opening again (Escape, then E in the preview) to its first painted
//   frame, drawn from the warm cache.
// A frame counts as painted when a message posted from the next
// requestAnimationFrame arrives (it runs after that frame's paint).
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The kit's screenshot tooling has puppeteer-core; nothing is added here.
const kitScripts = new URL("../../../../kit/scripts/", import.meta.url);
const { default: puppeteer } = await import(pathToFileURL(createRequire(kitScripts).resolve("puppeteer-core")).href);

const server = process.argv[2] ?? "http://127.0.0.1:38886";
function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), ".cache/puppeteer/chrome-headless-shell");
  if (!existsSync(base)) throw new Error("No Chrome: set CHROME");
  const dir = join(base, readdirSync(base).sort().at(-1));
  return join(dir, readdirSync(dir).find((d) => d.startsWith("chrome-headless-shell")), "chrome-headless-shell");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return `median ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${s.at(-1).toFixed(1)} ms (n=${s.length})`;
};

const browser = await puppeteer.launch({ executablePath: chrome(), headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 2 });
  await page.goto(`${server}/plugins/helix-bridge/editor/~files`, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForSelector("[data-files-list][data-rows]");
  await page.evaluate(() => window.__filesReveal("services/search/testdata/corpus/doc_02000.json"));
  await page.waitForFunction(() => document.querySelector("[data-files-list]")?.dataset.cursor === "services/search/testdata/corpus/doc_02000.json", { timeout: 10000 });
  await page.focus("[data-files-list]");
  const rows = await page.$eval("[data-files-list]", (el) => el.dataset.rows);
  // Per key: to React's commit (a document listener runs after the tree's
  // handler has rendered), and to the frame after it painted.
  await page.evaluate(() => {
    window.__keys = { z: { commit: [], frame: [] }, j: { commit: [], frame: [] } };
    document.addEventListener("keydown", (event) => {
      const into = window.__keys[event.key];
      if (!into) return;
      into.commit.push(performance.now() - event.timeStamp);
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => into.frame.push(performance.now() - event.timeStamp);
        channel.port2.postMessage(null);
      });
    });
  });
  for (const key of ["z", "j"]) {
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press(key);
      await sleep(40 + (i % 7) * 3);
    }
  }
  await sleep(200);
  const keys = await page.evaluate(() => window.__keys);
  const cursor = await page.$eval("[data-files-list]", (el) => el.dataset.cursor);
  console.log(`${rows} rows; cursor now on ${cursor}`);
  console.log(`  j, key to commit: ${stats(keys.j.commit.slice(5))}`);
  console.log(`  j, key to painted frame: ${stats(keys.j.frame.slice(5))}`);
  console.log(`  a key the tree ignores (z), to painted frame: ${stats(keys.z.frame.slice(5))}`);

  for (let i = 0; i < 20; i++) {
    await page.focus("[data-files-list]");
    await page.keyboard.press("Escape");
    await sleep(150);
    await page.keyboard.press("e");
    await sleep(250);
  }
  const opens = await page.evaluate(() => window.__filesTimeline.slice(1).map((e) => e.firstFrame).filter((x) => x !== null));
  console.log(`rail opened again to its first painted frame, from the cache: ${stats(opens)}`);
} finally {
  await browser.close();
}
