// Find how bb shows a thread terminal: open the thread, list the panel's
// controls and any xterm in the DOM, screenshot.
import { launch, SERVER, sleep } from "./browser.mjs";

const [path, shot] = process.argv.slice(2);
const { browser, page } = await launch();
try {
  await page.goto(SERVER + path, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(1500);
  const info = await page.evaluate(() => {
    const vis = (el) => el.getBoundingClientRect().width > 0;
    const labels = [...document.querySelectorAll("button[aria-label], [role=tab]")]
      .filter(vis)
      .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())
      .slice(0, 80);
    const xterms = [...document.querySelectorAll(".xterm, [class*=terminal], [data-terminal-id]")].map((el) => ({
      cls: el.className?.toString().slice(0, 80),
      rect: el.getBoundingClientRect().toJSON(),
    }));
    return { title: document.title, labels, xterms: xterms.slice(0, 10) };
  });
  console.log(JSON.stringify(info, null, 1));
  if (shot) await page.screenshot({ path: shot });
} finally {
  await browser.close();
}
