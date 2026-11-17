// Quit Helix from the thread's Helix tab: the tab closes and the composer
// gets focus.
import { execFileSync } from "node:child_process";
import { launch, SERVER, sleep } from "./browser.mjs";
const [thread = "thr_fh7kmixkaj", project = "proj_v2ia75srgp"] = process.argv.slice(2);
const { browser, page } = await launch({ width: 1440, height: 900, theme: "light" });
const tabs = () => page.evaluate(() => [...document.querySelectorAll("#thread-detail-secondary-panel button")].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 12));
try {
  await page.goto(`${SERVER}/projects/${project}/threads/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(1500);
  await page.evaluate(() => [...document.querySelectorAll('button[aria-label^="Show right panel"]')].find((b) => b.getBoundingClientRect().width > 0)?.click());
  await sleep(700);
  await page.evaluate(() => [...document.querySelectorAll("button[data-panel-new-tab]")].find((b) => b.getBoundingClientRect().width > 0)?.click());
  await sleep(600);
  await page.evaluate(() => [...document.querySelectorAll("#thread-detail-secondary-panel [data-panel-new-tab-item]")].find((b) => b.textContent.trim() === "Helix")?.click());
  await page.waitForSelector("[data-helix-terminal] canvas, [data-helix-terminal] .term-grid", { timeout: 30000 });
  await sleep(3500);
  const ours = execFileSync("bb", ["hx", "list"], { encoding: "utf8" }).split("\n").find((l) => l.includes(`-> ${thread}`) && l.includes("(terminal)"));
  if (!ours) throw new Error("our Helix is not bound to our thread by its terminal");
  const before = await tabs();
  await page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
  await page.keyboard.press("Escape");
  await page.keyboard.type(":q");
  await page.keyboard.press("Enter");
  await sleep(2500);
  console.log(JSON.stringify({ before, after: await tabs(), surface: await page.evaluate(() => Boolean(document.querySelector("[data-helix-terminal]"))), composerFocused: await page.evaluate(() => Boolean(document.activeElement?.closest?.("[data-promptbox-layout]"))), terminals: execFileSync("bb", ["terminal", "list", "--thread", thread], { encoding: "utf8" }).split("\n").filter((l) => /Helix.*running/u.test(l)).length }, null, 1));
} finally { await browser.close(); }
