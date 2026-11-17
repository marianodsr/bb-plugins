// Open the editor page (the plugin starts Helix and attaches at once), press
// Escape, and read what was sent: "ESC" (legacy) or "ESC [27u" (Kitty).
import { execFileSync } from "node:child_process";
import { launch, SERVER, sleep } from "./browser.mjs";
const thread = process.argv[2] ?? "thr_fh7kmixkaj";
const { browser, page } = await launch({ width: 1440, height: 900, theme: "dark" });
try {
  await page.goto(`${SERVER}/plugins/helix-bridge/editor/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForSelector("[data-helix-hud]", { timeout: 30000 });
  await sleep(3000);
  const ours = execFileSync("bb", ["hx", "list"], { encoding: "utf8" }).split("\n").find((l) => l.includes(`-> ${thread}`) && l.includes("(terminal)"));
  if (!ours) throw new Error("not ours");
  await page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
  await page.keyboard.press("Escape");
  await sleep(700);
  const sent = await page.evaluate(() => [...document.querySelectorAll("[data-helix-hud] > span")].map((s) => s.textContent));
  console.log(JSON.stringify({ instance: ours.slice(0, 60), sent: sent[sent.indexOf("Sent") + 1] }));
  await page.keyboard.type(":q");
  await page.keyboard.press("Enter");
  await sleep(1500);
} finally { await browser.close(); }
