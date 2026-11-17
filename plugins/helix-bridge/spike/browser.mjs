// Shared headless Chrome helpers for the terminal spike. puppeteer-core comes
// from the kit's script folder so this plugin does not depend on it.
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire("/Users/marianodsr/projects/bb-plugins/kit/scripts/package.json");
export const puppeteer = require("puppeteer-core");
export const SERVER = process.env.BB_SERVER ?? "http://127.0.0.1:38886";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), ".cache/puppeteer/chrome-headless-shell");
  if (!existsSync(base)) throw new Error("No chrome-headless-shell in ~/.cache/puppeteer");
  const versions = readdirSync(base).sort();
  const dir = join(base, versions[versions.length - 1]);
  const sub = readdirSync(dir).find((d) => d.startsWith("chrome-headless-shell"));
  return join(dir, sub, "chrome-headless-shell");
}

export async function launch({ width = 1440, height = 900, theme = "dark" } = {}) {
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`  pageerror: ${String(e).slice(0, 200)}`));
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument((t) => localStorage.setItem("bb.theme", t), theme);
  return { browser, page };
}
