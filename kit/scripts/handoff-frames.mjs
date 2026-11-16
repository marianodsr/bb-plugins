#!/usr/bin/env node
// Trigger the gallery's handoff in headless Chrome and capture frames during
// the flight, plus the packet's position at each frame. Used to check the
// signature motion without eyeballing it live.
//
//   node kit/scripts/handoff-frames.mjs --target thread|current|new|fail \
//     [--theme light|dark] [--width 1440] [--height 1000] [--scroll <px>] [--reduced-motion] --out <dir>
//     [--thread <projectId>/<threadId> --real]
//
// With --thread the gallery is opened as that thread's side-panel tab; --real
// switches the demo to bb's live threads and SDK. Use --target current with
// --real to insert into the real composer: drafts are this headless
// browser's localStorage, so nothing reaches the user's own composer, but the
// thread's kit-gallery plugin metadata is written.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const target = opt("target", "thread");
const theme = opt("theme", "light");
const width = Number(opt("width", "1440"));
const height = Number(opt("height", "1000"));
const out = resolve(opt("out", "docs/screenshots/kit-gallery/handoff"));
const reduced = argv.includes("--reduced-motion");
const server = opt("server", "http://127.0.0.1:38886");
const thread = opt("thread");
const real = argv.includes("--real");
const scroll = opt("scroll");
mkdirSync(out, { recursive: true });

const base = join(homedir(), ".cache/puppeteer/chrome-headless-shell");
const v = readdirSync(base).sort().pop();
const exe = process.env.CHROME ?? join(base, v, readdirSync(join(base, v)).find((d) => d.startsWith("chrome")), "chrome-headless-shell");
if (!existsSync(exe)) throw new Error(`no chrome at ${exe}`);

const browser = await puppeteer.launch({ executablePath: exe, headless: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 300)));
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: theme },
    { name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" },
  ]);
  await page.evaluateOnNewDocument((t) => localStorage.setItem("bb.theme", t), theme);
  if (thread) {
    const [projectId, threadId] = thread.split("/");
    await page.goto(`${server}/projects/${projectId}/threads/${threadId}`, { waitUntil: "networkidle2", timeout: 45000 });
    await sleep(1200);
    await page.evaluate(() => [...document.querySelectorAll('button[aria-label^="Show right panel"]')].find((b) => b.getBoundingClientRect().width > 0)?.click());
    await sleep(700);
    await page.evaluate(() => [...document.querySelectorAll("button[data-panel-new-tab]")].find((b) => b.getBoundingClientRect().width > 0)?.click());
    await sleep(500);
    await page.evaluate(() => {
      const panel = document.querySelector("#thread-detail-secondary-panel");
      [...panel.querySelectorAll("button, a, li, [role=option], [role=menuitem]")].reverse().find((el) => el.textContent.trim() === "Kit Gallery")?.click();
    });
  } else {
    await page.goto(`${server}/plugins/kit-gallery/gallery`, { waitUntil: "networkidle2", timeout: 45000 });
  }
  await sleep(1500);
  if (scroll) {
    // Park the fake composer this many px above the viewport's bottom edge.
    await page.evaluate((gap) => {
      const box = document.querySelector('[aria-label="Fake destinations"] [data-promptbox-layout]');
      const scroller = document.querySelector("[data-gallery-scroll]");
      const r = box.getBoundingClientRect();
      scroller.scrollBy(0, r.top - (innerHeight - Number(gap)));
    }, scroll);
    await sleep(300);
  }
  if (real) {
    await page.evaluate(() => [...document.querySelectorAll("label")].find((l) => l.textContent.includes("Real threads"))?.click());
    await sleep(300);
  }

  // Select the second comment too, so two items fly.
  const rows = await page.$$('[aria-label="Items"] [data-row]');
  await rows[1].click();
  await sleep(150);
  if (target === "fail") await page.click('label:has(button[role="checkbox"]) >> text/Fail next send').catch(async () => {
    const labels = await page.$$("label");
    for (const l of labels) if ((await l.evaluate((n) => n.textContent)).includes("Fail next send")) await l.click();
  });
  // Open the sheet with its button (the S hotkey needs focus on the page).
  await page.click(`button[aria-keyshortcuts="s"]`);
  await sleep(400);
  await page.screenshot({ path: join(out, `${target}-${theme}-${width}-0-sheet.png`) });

  // Choose the target with the keyboard.
  if (target === "current") {
    await page.keyboard.press("Enter"); // first option: Insert into composer
  } else if (target === "new") {
    await page.keyboard.down("Meta");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Meta");
  } else {
    await page.keyboard.type("Jira");
    await sleep(120);
    await page.keyboard.press("Enter");
  }
  const t0 = Date.now();
  const frames = [];
  for (let i = 0; i < 14; i++) {
    const state = await page.evaluate(() => {
      const layer = document.querySelector("[data-kit-handoff-layer]");
      const packet = layer?.querySelector(".rounded-full.bg-foreground");
      const r = packet?.getBoundingClientRect();
      return {
        layers: document.querySelectorAll("[data-kit-handoff-layer]").length,
        ghosts: layer ? layer.querySelectorAll(".rounded-lg.bg-card").length : 0,
        packet: r ? { x: Math.round(r.x), y: Math.round(r.y), o: getComputedStyle(packet).opacity } : null,
        sourceOpacity: getComputedStyle(document.querySelector('[aria-label="Items"] [data-row]')).opacity,
        chip: document.querySelector('[role="status"] [data-kit-thread-chip]')?.textContent ?? null,
        composer: (document.querySelector("[data-promptbox-layout] [contenteditable]")?.textContent ?? "").slice(0, 60),
        target: (() => {
          const boxes = [...document.querySelectorAll("[data-promptbox-layout]")].map((el) => el.getBoundingClientRect()).filter((b) => b.bottom > 0 && b.top < innerHeight);
          const b = boxes[0];
          return b ? { top: Math.round(b.top), bottom: Math.round(b.bottom), visibleMidY: Math.round((Math.max(b.top, 0) + Math.min(b.bottom, innerHeight)) / 2) } : null;
        })(),
        viewport: innerHeight,
      };
    });
    const t = Date.now() - t0;
    frames.push({ t, ...state });
    if (i % 2 === 0 || i < 6) await page.screenshot({ path: join(out, `${target}-${theme}-${width}-${String(i + 1).padStart(2, "0")}-${t}ms.png`), type: "png" });
    await sleep(25);
  }
  await sleep(600);
  await page.screenshot({ path: join(out, `${target}-${theme}-${width}-99-after.png`) });
  console.log(JSON.stringify(frames, null, 0).replaceAll("},{", "},\n{"));
} finally {
  await browser.close();
}
