import { launch, openPage, showPanel, sleep, shot } from "./lib.mjs";
const browser = await launch();
try {
  const page = await openPage(browser, { path: process.argv[2] });
  await showPanel(page);
  await page.evaluate(() => [...document.querySelectorAll("button[data-panel-new-tab]")].find((b) => b.getBoundingClientRect().width > 0)?.click());
  await sleep(600);
  const info = await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 300), menus: [...document.querySelectorAll('[role="menu"],[role="dialog"],[role="listbox"],[cmdk-root]')].map((e) => e.outerHTML.slice(0, 400)) }));
  console.log(JSON.stringify(info, null, 1));
  await shot(page, process.env.OUT ?? "/tmp", "probe-newtab");
} finally { await browser.close(); }
