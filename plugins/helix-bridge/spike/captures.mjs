#!/usr/bin/env node
// Captures of the editor page for review: each theme at each width, driven
// with real keys (Shift+Cmd+H into the rail, j to skim, the flyout open).
// Scenes: "changes" (the rail on Changes with the flyout), "files" (the tree),
// "sheet" (the rail as a sheet; at 420 px bb's sidebar is a closed drawer).
//
//   node spike/captures.mjs --thread <id> --out <dir> [--widths 1440,420] [--themes dark,light] [--scenes changes,files] [--prefix rail]
import { mkdirSync } from "node:fs";
import { launch, SERVER, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const thread = opt("thread", "thr_n2derddyg6");
const out = opt("out", "spike/out");
const prefix = opt("prefix", "rail");
const widths = opt("widths", "1440,420").split(",").map(Number);
const themes = opt("themes", "dark,light").split(",");
const scenes = opt("scenes", "changes,files").split(",");
mkdirSync(out, { recursive: true });

async function chord(page, mods, key) {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
}

for (const theme of themes) {
  for (const width of widths) {
    for (const scene of scenes) {
      const { browser, page } = await launch({ width, height: width < 600 ? 860 : 900, theme });
      try {
        await page.evaluateOnNewDocument((tab) => localStorage.setItem("helix-bridge.rail.tab", tab), scene === "files" ? "files" : "changes");
        await page.goto(`${SERVER}/plugins/helix-bridge/editor/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
        await page.waitForSelector("[data-helix-terminal]", { timeout: 30000 });
        await sleep(4500);
        await page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
        await chord(page, ["Meta", "Shift"], "h");
        await sleep(900);
        if (scene === "changes") {
          await page.keyboard.press("j");
          await sleep(700);
        }
        const path = `${out}/${prefix}-${scene}-${width}-${theme}.png`;
        await page.screenshot({ path });
        console.log(path);
      } finally {
        await browser.close();
      }
    }
  }
}
