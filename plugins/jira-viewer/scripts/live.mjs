// Live checks for Jira Viewer in a private headless Chrome (dev only).
//
//   node plugins/jira-viewer/scripts/live.mjs <scenario> [--theme light|dark] [--out dir]
//
// Scenarios
//   sheet        open ENG-412 on the page, press T, shoot the handoff sheet
//   tab          open this thread's side panel on the Issue tab (needs a link)
//   handoff      in the Issue tab: Send to thread, This thread (insert into the
//                composer). Captures packet frames; then starts a second
//                handoff mid-flight to check interruption. Drafts live in this
//                browser's localStorage only; nothing is sent.
//   flash        load the list, change OPS-7 in the mock, refresh, shoot frames
//   skeleton     shoot the list 400 ms after load against a slow mock
//   reduced      the handoff with prefers-reduced-motion
//
// Chrome cannot start inside the agent sandbox; run unsandboxed.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(new URL("../../../kit/scripts/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");

const argv = process.argv.slice(2);
const scenario = argv[0];
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const theme = opt("theme", "light");
const out = resolve(opt("out", "docs/screenshots/jira-viewer/live"));
const server = opt("server", "http://127.0.0.1:38886");
const project = opt("project", "proj_v2ia75srgp");
const thread = opt("thread", "thr_23bvxgkset");
const mock = opt("mock", "http://127.0.0.1:4010");
const reduced = scenario === "reduced" || argv.includes("--reduced-motion");
mkdirSync(out, { recursive: true });

const base = join(homedir(), ".cache/puppeteer/chrome-headless-shell");
const v = readdirSync(base).sort().pop();
const exe = process.env.CHROME ?? join(base, v, readdirSync(join(base, v)).find((d) => d.startsWith("chrome")), "chrome-headless-shell");
if (!existsSync(exe)) throw new Error(`no chrome at ${exe}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: exe, headless: true });
const shot = (page, name) => page.screenshot({ path: join(out, `${scenario}-${theme}-${name}.png`) });

async function openThreadIssueTab(page, width) {
  await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
  await page.goto(`${server}/projects/${project}/threads/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(1500);
  const opened = await page.evaluate(() => {
    const tab = [...document.querySelectorAll("button, [role=tab]")].find(
      (b) => b.textContent.trim() === "Issue" && b.getBoundingClientRect().width > 0,
    );
    if (tab) {
      tab.click();
      return "tab";
    }
    const toggle = [...document.querySelectorAll('button[aria-label^="Show right panel"]')].find((b) => b.getBoundingClientRect().width > 0);
    toggle?.click();
    return toggle ? "panel" : "none";
  });
  await sleep(800);
  if (opened !== "tab") {
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll("button, [role=tab]")].find(
        (b) => b.textContent.trim() === "Issue" && b.getBoundingClientRect().width > 0,
      );
      tab?.click();
    });
    await sleep(1500);
  }
}

async function frames(page, label, count = 16) {
  const t0 = Date.now();
  const list = [];
  for (let i = 0; i < count; i++) {
    const state = await page.evaluate(() => {
      const layer = document.querySelector("[data-kit-handoff-layer]");
      const packet = layer?.querySelector(".rounded-full.bg-foreground");
      const r = packet?.getBoundingClientRect();
      return {
        layers: document.querySelectorAll("[data-kit-handoff-layer]").length,
        packet: r ? { x: Math.round(r.x), y: Math.round(r.y), o: getComputedStyle(packet).opacity } : null,
        chip: document.querySelector("[data-kit-thread-chip]")?.textContent ?? null,
        composer: (document.querySelector("[data-promptbox-layout] [contenteditable]")?.textContent ?? "").slice(0, 50),
      };
    });
    list.push({ t: Date.now() - t0, ...state });
    if (i < 8 || i % 3 === 0) await shot(page, `${label}-${String(i).padStart(2, "0")}`);
    await sleep(20);
  }
  console.log(label, JSON.stringify(list).replaceAll("},{", "},\n{"));
}

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 300)));
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: theme },
    { name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" },
  ]);
  await page.evaluateOnNewDocument((t) => localStorage.setItem("bb.theme", t), theme);

  if (scenario === "sheet") {
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.goto(`${server}/plugins/jira-viewer/issues/views/my-open/ENG-412`, { waitUntil: "networkidle2" });
    await sleep(2000);
    await page.keyboard.press("t");
    await sleep(500);
    await shot(page, "open");
    await page.keyboard.press("Escape");
    await sleep(400);
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 40));
    console.log("focus after Escape:", focused);
    await shot(page, "closed");
  } else if (scenario === "tab") {
    for (const width of [1160, 1920]) {
      await openThreadIssueTab(page, width);
      await shot(page, String(width));
    }
  } else if (scenario === "handoff" || scenario === "reduced") {
    await openThreadIssueTab(page, 1440);
    await shot(page, "start");
    await page.evaluate(() => {
      const send = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Send to thread") && b.getBoundingClientRect().width > 0);
      send?.click();
    });
    await sleep(500);
    await shot(page, "sheet");
    await page.keyboard.press("Enter"); // first option: This thread, insert
    await frames(page, "flight");
    await sleep(600);
    await shot(page, "after");
    if (scenario === "handoff") {
      // Interrupt: start a second handoff while the first is in the air.
      await page.evaluate(() => {
        const send = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Send to thread") && b.getBoundingClientRect().width > 0);
        send?.click();
      });
      await sleep(350);
      await page.keyboard.press("Enter");
      await sleep(120);
      await page.evaluate(() => {
        const send = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Send to thread") && b.getBoundingClientRect().width > 0);
        send?.click();
      });
      await sleep(300);
      await page.keyboard.press("Enter");
      await frames(page, "interrupt", 10);
      await sleep(700);
      await shot(page, "interrupt-after");
    }
  } else if (scenario === "taskboard") {
    await openThreadIssueTab(page, 1440);
    await page.evaluate(() => {
      const add = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Add to Task Board") && b.getBoundingClientRect().width > 0);
      add?.click();
    });
    await sleep(150);
    await shot(page, "pending");
    await sleep(1500);
    await shot(page, "added");
    console.log("footer:", await page.evaluate(() => [...document.querySelectorAll("footer")].map((f) => f.textContent).join(" | ")));
  } else if (scenario === "views") {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${server}/plugins/jira-viewer/issues`, { waitUntil: "networkidle2" });
    await sleep(1500);
    await page.keyboard.press("n");
    await sleep(300);
    await page.keyboard.type("Ops on fire");
    await page.keyboard.press("Tab");
    await page.keyboard.type("project = OPS ORDER BY updated DESC");
    await shot(page, "1-form");
    await page.keyboard.press("Enter");
    await sleep(80);
    await shot(page, "2-optimistic");
    await sleep(1500);
    await shot(page, "3-created");
    // Reorder: focus the new row and press Alt+ArrowUp twice.
    await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Saved views"] button')].find((b) => b.textContent.trim() === "Ops on fire")?.focus());
    for (let i = 0; i < 2; i++) {
      await page.keyboard.down("Alt");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.up("Alt");
      await sleep(250);
    }
    await sleep(500);
    await shot(page, "4-reordered");
    console.log("order:", await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Saved views"] li')].map((li) => li.textContent.trim()).join(" | ")));
    // Edit in place.
    await page.click('button[aria-label="Edit Ops on fire"]');
    await sleep(250);
    await shot(page, "5-edit");
    await page.keyboard.press("Tab");
    await page.keyboard.down("Meta");
    await page.keyboard.press("a");
    await page.keyboard.up("Meta");
    await page.keyboard.type("project = OPS AND statusCategory != Done");
    await page.keyboard.press("Enter");
    await sleep(1200);
    await shot(page, "6-edited");
    // Delete, then undo from the toast.
    await page.click('button[aria-label="Delete Ops on fire"]');
    await sleep(400);
    await shot(page, "7-deleted");
    const undo = await page.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Undo"));
    if (undo) await undo.click();
    await sleep(1500);
    await shot(page, "8-restored");
    console.log("after undo:", await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Saved views"] li')].map((li) => li.textContent.trim()).join(" | ")));
  } else if (scenario === "flash") {
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.goto(`${server}/plugins/jira-viewer/issues/views/my-open`, { waitUntil: "networkidle2" });
    await sleep(2000);
    await fetch(`${mock}/__mock/touch`, { method: "POST", body: JSON.stringify({ key: "OPS-7", summary: "Rotate staging and prod certificates" }) });
    await page.keyboard.press("r");
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      await shot(page, `${String(i).padStart(2, "0")}-${Date.now() - t0}ms`);
      await sleep(90);
    }
  } else if (scenario === "skeleton") {
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.goto(`${server}/plugins/jira-viewer/issues/views/reported`, { waitUntil: "domcontentloaded" });
    let elapsed = 0;
    for (const at of [300, 900, 1600, 4000]) {
      await sleep(at - elapsed);
      elapsed = at;
      await shot(page, `${at}ms`);
    }
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
} finally {
  await browser.close();
}
