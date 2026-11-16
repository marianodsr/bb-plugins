// Headless Chrome helpers for live checks of Review Editor. Uses the kit's
// puppeteer-core install and a private browser profile, so the user's bb
// (theme, drafts, open tabs) is never touched. Run outside the sandbox.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(new URL("../../../kit/scripts/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");

export const SERVER = "http://127.0.0.1:38886";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), ".cache/puppeteer/chrome-headless-shell");
  const version = readdirSync(base).sort().pop();
  const dir = join(base, version);
  return join(dir, readdirSync(dir).find((d) => d.startsWith("chrome-headless-shell")), "chrome-headless-shell");
}

export async function launch() {
  const exe = chrome();
  if (!existsSync(exe)) throw new Error(`no chrome at ${exe}`);
  return puppeteer.launch({ executablePath: exe, headless: true });
}

export async function openPage(browser, { path, theme = "light", width = 1440, height = 900, reduced = false, baseRef = null }) {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.log(`  pageerror: ${String(error).slice(0, 300)}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`  console: ${message.text().slice(0, 300)}`);
  });
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: theme },
    { name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" },
  ]);
  await page.evaluateOnNewDocument((t) => localStorage.setItem("bb.theme", t), theme);
  if (baseRef) await page.evaluateOnNewDocument((r) => localStorage.setItem("review-editor.devBaseRef", r), baseRef);
  await page.goto(SERVER + path, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(1200);
  return page;
}

export async function showPanel(page) {
  await page.evaluate(() => {
    const show = [...document.querySelectorAll('button[aria-label^="Show right panel"]')].find((b) => b.getBoundingClientRect().width > 0);
    show?.click();
  });
  await sleep(700);
}

/** Open a workspace file in the side panel through New tab's file search. */
export async function openFile(page, filePath) {
  await showPanel(page);
  await page.evaluate(() =>
    [...document.querySelectorAll("button[data-panel-new-tab]")].find((b) => b.getBoundingClientRect().width > 0)?.click(),
  );
  await sleep(500);
  await page.keyboard.type(filePath, { delay: 5 });
  await sleep(1500);
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const clicked = await page.evaluate((name) => {
    const panel = document.querySelector("#thread-detail-secondary-panel") ?? document;
    const rows = [...panel.querySelectorAll('[role="option"], [cmdk-item], button, li')].filter(
      (el) =>
        el.getBoundingClientRect().height > 0 &&
        !el.closest("[data-tab-pill], [data-secondary-panel-tab-content]") &&
        (el.textContent ?? "").trim().startsWith(name),
    );
    rows[0]?.click();
    return rows.length;
  }, name);
  if (!clicked) console.log(`  no result for ${filePath}`);
  await sleep(2000);
}

export async function shot(page, out, name) {
  mkdirSync(out, { recursive: true });
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
  return file;
}

/** Close panel tabs whose title matches (panel tabs persist on the server). */
export async function closeTabs(page, titles) {
  const closed = await page.evaluate((titles) => {
    const done = [];
    for (const button of [...document.querySelectorAll("button[data-tab-pill-close]")]) {
      const title = (button.getAttribute("aria-label") ?? "").replace(/^Close /, "");
      if (!titles.includes(title)) continue;
      button.click();
      done.push(title);
    }
    return done;
  }, titles);
  await sleep(600);
  return closed;
}

/** Click the panel tab pill with this exact title. */
export async function selectTab(page, title) {
  const ok = await page.evaluate((title) => {
    const span = [...document.querySelectorAll("[data-tab-pill] span[title]")].find((s) => s.getAttribute("title") === title);
    span?.closest("button")?.click();
    return Boolean(span);
  }, title);
  if (!ok) console.log(`  no tab "${title}"`);
  await sleep(900);
  return ok;
}

/** Click the first visible element matching selector whose text includes `text`. */
export async function clickText(page, selector, text) {
  const ok = await page.evaluate((selector, text) => {
    const el = [...document.querySelectorAll(selector)].find((e) => e.getBoundingClientRect().height > 0 && (e.textContent ?? "").includes(text));
    el?.click();
    return Boolean(el);
  }, selector, text);
  if (!ok) console.log(`  nothing to click: ${selector} "${text}"`);
  await sleep(900);
  return ok;
}

export async function panelWidth(page) {
  return page.evaluate(() => Math.round(document.querySelector("#thread-detail-secondary-panel")?.getBoundingClientRect().width ?? 0));
}
