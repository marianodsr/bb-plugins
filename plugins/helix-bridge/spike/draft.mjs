// A :bb-send from the mock lands in a real thread's composer; then Enter
// submits it and the position pill is attached at that moment.
import { execFileSync } from "node:child_process";
import { launch, SERVER, sleep } from "./browser.mjs";
const [thread, project, ctl, outDir] = process.argv.slice(2);
const control = (cmd) => JSON.parse(execFileSync("node", ["test/mock-bridge/ctl.mjs", ctl, JSON.stringify(cmd)], { encoding: "utf8" }));
const { browser, page } = await launch({ width: 1440, height: 900, theme: "light" });
const composerText = () => page.evaluate(() => [...document.querySelectorAll('[data-promptbox-layout] [contenteditable="true"]')].map((e) => e.innerText).join("|"));
try {
  await page.goto(`${SERVER}/projects/${project}/threads/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForSelector("[data-helix-position]", { timeout: 20000 });
  control({ cmd: "select", line: 10, col: 1, endLine: 12, endCol: 1 });
  console.log("send:", control({ cmd: "send", kind: "send", note: "Reply with only the Helix editor position line you were given with this message, then stop." }).ok);
  await page.waitForFunction(() => document.body.innerText.includes("From Helix"), { timeout: 15000 });
  await sleep(600);
  console.log("composer after draft:", JSON.stringify(await composerText()));
  await page.screenshot({ path: `${outDir}/draft-landed-light-1440.png` });
  const editor = await page.$('[data-promptbox-layout] [contenteditable="true"]');
  await editor.click();
  await page.keyboard.down("Meta"); await page.keyboard.press("ArrowDown"); await page.keyboard.up("Meta");
  await page.keyboard.press("Enter");
  await sleep(2500);
  console.log("composer after Enter:", JSON.stringify(await composerText()));
  await page.screenshot({ path: `${outDir}/draft-sent-light-1440.png` });
} finally { await browser.close(); }
