#!/usr/bin/env node
// Drive the Task Board in a private headless Chrome and run a scenario.
//
//   node plugins/task-board/scripts/drive.mjs <scenario.mjs> [--theme light|dark]
//     [--width 1440] [--height 1000] [--reduced-motion]
//
// A scenario default-exports `async (page, tools)`; tools has `sleep(ms)`,
// `go(path)`, `shot(name)` (PNG into docs/screenshots/task-board/) and
// `log(...)`. Chrome comes from the kit's puppeteer install. Like the kit's
// shoot.mjs, run it outside the agent sandbox; it only touches its own
// browser profile, never the user's bb settings.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const require = createRequire(join(repo, "kit/scripts/package.json"));
const puppeteer = require("puppeteer-core");

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const scenarioPath = resolve(argv[0]);
const theme = opt("theme", "light");
const width = Number(opt("width", "1440"));
const height = Number(opt("height", "1000"));
const server = opt("server", "http://127.0.0.1:38886");
const out = join(repo, "docs/screenshots/task-board");
mkdirSync(out, { recursive: true });

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), ".cache/puppeteer/chrome-headless-shell");
  if (!existsSync(base)) throw new Error("No chrome-headless-shell in ~/.cache/puppeteer");
  const versions = readdirSync(base).sort();
  const dir = join(base, versions[versions.length - 1]);
  const sub = readdirSync(dir).find((d) => d.startsWith("chrome-headless-shell"));
  return join(dir, sub, "chrome-headless-shell");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`pageerror: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => {
    if (m.type() === "error" && /task-board|plugin/i.test(m.text())) console.log(`console: ${m.text().slice(0, 300)}`);
  });
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: theme },
    { name: "prefers-reduced-motion", value: argv.includes("--reduced-motion") ? "reduce" : "no-preference" },
  ]);
  await page.evaluateOnNewDocument((t) => localStorage.setItem("bb.theme", t), theme);
  const tools = {
    theme,
    width,
    sleep,
    log: (...args) => console.log(...args),
    go: async (path) => {
      await page.goto(server + path, { waitUntil: "networkidle2", timeout: 45000 });
      await sleep(1000);
    },
    shot: async (name, options = {}) => {
      const file = join(out, `${name}.png`);
      await page.screenshot({ path: file, ...options });
      console.log(file);
      return file;
    },
  };
  const scenario = (await import(pathToFileURL(scenarioPath).href)).default;
  await scenario(page, tools);
} finally {
  await browser.close();
}
