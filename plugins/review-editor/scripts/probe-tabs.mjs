import { launch, openPage, showPanel, sleep } from "./lib.mjs";
const browser = await launch();
try {
  const page = await openPage(browser, { path: process.argv[2] });
  await showPanel(page);
  console.log(await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.textContent ?? "").trim() === "session.ts.reviewspike");
    let n = el; for (let i = 0; i < 4 && n?.parentElement; i++) n = n.parentElement;
    return n?.outerHTML.slice(0, 2500);
  }));
} finally { await browser.close(); }
