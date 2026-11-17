// Type into a thread's composer key by key and check the draft is exactly
// what was typed (the position chip must not touch it). Never submits; the
// draft is cleared afterwards.
import { launch, SERVER, sleep } from "./browser.mjs";
const [thread = "thr_fh7kmixkaj", project = "proj_v2ia75srgp", shot] = process.argv.slice(2);
const { browser, page } = await launch({ width: 1440, height: 900, theme: "light" });
const text = () => page.evaluate(() => [...document.querySelectorAll('[data-promptbox-layout] [contenteditable="true"]')].map((e) => e.innerText).join("|"));
try {
  await page.goto(`${SERVER}/projects/${project}/threads/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForSelector("[data-helix-position]", { timeout: 20000 });
  const editor = await page.$('[data-promptbox-layout] [contenteditable="true"]');
  await editor.click();
  let typed = "";
  const bad = [];
  for (const ch of "how is it going") {
    await page.keyboard.type(ch);
    typed += ch;
    await sleep(120);
    const now = (await text()).replace(/ /g, " ");
    if (now !== typed) bad.push({ typed, now });
  }
  console.log(JSON.stringify({ final: await text(), chip: await page.$eval("[data-helix-position]", (e) => e.textContent), mismatches: bad }));
  if (shot) await page.screenshot({ path: shot });
  await page.keyboard.down("Meta"); await page.keyboard.press("a"); await page.keyboard.up("Meta"); await page.keyboard.press("Backspace");
  await sleep(500);
} finally { await browser.close(); }
