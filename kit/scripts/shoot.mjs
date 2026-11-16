#!/usr/bin/env node
// Screenshot a bb page in light and dark at several widths, in a private
// headless Chrome. The theme is set through this browser's own localStorage
// ("bb.theme"), so the user's bb is never touched.
//
//   node kit/scripts/shoot.mjs --path /plugins/kit-gallery/gallery \
//     --out docs/screenshots/kit-gallery --name page
//
// Options
//   --path <app path>        page to open (required), e.g. /plugins/<id>/<panel>
//   --out <dir>              output directory (created)
//   --name <prefix>          file prefix; files are <prefix>-<theme>-<width>.png
//   --themes light,dark      default both
//   --widths 1440,420        viewport widths, default 1440,420
//   --height <px>            viewport height, default 1000
//   --panel-tab <title>      after load, open the thread's right panel and open
//                            the action tab with this title from "Open new tab".
//                            The panel takes half of what the sidebar leaves:
//                            viewport 1160 gives a 420 px panel, 1920 gives 800.
//   --scroll <selector>=<y>  scroll an element before the shot
//   --click <selector>       click an element before the shot (repeatable)
//   --keys <keys>            press keys before the shot, comma separated
//   --wait <ms>              extra settle time, default 800
//   --reduced-motion         emulate prefers-reduced-motion: reduce
//   --server <url>           default http://127.0.0.1:38886
//
// Chrome: uses $CHROME, else the newest puppeteer chrome-headless-shell in
// ~/.cache/puppeteer. Inside the agent sandbox Chrome cannot start (mach port
// denied); run this command with the sandbox disabled.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const flag = (name) => argv.includes(`--${name}`);

const path = opt("path");
if (!path) {
  console.error("--path is required");
  process.exit(2);
}
const server = opt("server", "http://127.0.0.1:38886");
const out = resolve(opt("out", "."));
const name = opt("name", "shot");
const themes = opt("themes", "light,dark").split(",");
const widths = opt("widths", "1440,420").split(",").map(Number);
const height = Number(opt("height", "1000"));
const wait = Number(opt("wait", "800"));
const panelTab = opt("panel-tab");
const clicks = all("click");
const scrolls = all("scroll");
const keys = opt("keys");

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), ".cache/puppeteer/chrome-headless-shell");
  if (!existsSync(base)) throw new Error("No Chrome: set CHROME or install chrome-headless-shell with puppeteer");
  const versions = readdirSync(base).sort();
  const dir = join(base, versions[versions.length - 1]);
  const sub = readdirSync(dir).find((d) => d.startsWith("chrome-headless-shell"));
  return join(dir, sub, "chrome-headless-shell");
}

mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (const theme of themes) {
    for (const width of widths) {
      const page = await browser.newPage();
      page.on("pageerror", (e) => console.log(`  pageerror: ${String(e).slice(0, 200)}`));
      await page.setViewport({ width, height, deviceScaleFactor: 2 });
      await page.emulateMediaFeatures([
        { name: "prefers-color-scheme", value: theme },
        { name: "prefers-reduced-motion", value: flag("reduced-motion") ? "reduce" : "no-preference" },
      ]);
      await page.evaluateOnNewDocument((t) => localStorage.setItem("bb.theme", t), theme);
      await page.goto(server + path, { waitUntil: "networkidle2", timeout: 45000 });
      await sleep(1200);
      if (panelTab) await openPanelTab(page, panelTab);
      for (const s of scrolls) {
        const [sel, y] = s.split("=");
        await page.evaluate((sel, y) => document.querySelector(sel)?.scrollTo(0, Number(y)), sel, y);
      }
      for (const sel of clicks) {
        await page.click(sel).catch((e) => console.log(`  click ${sel} failed: ${e.message}`));
        await sleep(300);
      }
      if (keys) for (const k of keys.split(",")) await page.keyboard.press(k);
      await sleep(wait);
      const file = join(out, `${name}-${theme}-${width}.png`);
      await page.screenshot({ path: file });
      console.log(file);
      await page.close();
    }
  }
} finally {
  await browser.close();
}

async function openPanelTab(page, title) {
  // bb's own panel chrome, matched by accessible names (bb 0.49): "Show right
  // panel", then "Open new tab", then the menu entry with the tab's title.
  const shown = await page.evaluate(() => {
    const show = [...document.querySelectorAll('button[aria-label^="Show right panel"]')].find(
      (b) => b.getBoundingClientRect().width > 0,
    );
    show?.click();
    return Boolean(show);
  });
  if (shown) await sleep(700);
  {
    await page.evaluate(() =>
      [...document.querySelectorAll("button[data-panel-new-tab]")].find((b) => b.getBoundingClientRect().width > 0)?.click(),
    );
    await sleep(500);
    const clicked = await page.evaluate((title) => {
      const panel = document.querySelector("#thread-detail-secondary-panel") ?? document;
      const items = [...panel.querySelectorAll('[role="menuitem"], [role="option"], button, a, li, [cmdk-item]')];
      const item = items.reverse().find((el) => (el.textContent ?? "").trim() === title);
      item?.click();
      return Boolean(item);
    }, title);
    if (!clicked) console.log(`  no "${title}" entry in the new-tab menu`);
  }
  await sleep(1200);
  const width = await page.evaluate(() => {
    const panel = document.querySelector("#thread-detail-secondary-panel");
    return panel ? Math.round(panel.getBoundingClientRect().width) : null;
  });
  console.log(`  side panel width: ${width ?? "?"} px`);
}
