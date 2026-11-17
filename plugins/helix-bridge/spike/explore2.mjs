// Open the right panel and list its tabs and new-tab menu.
import { launch, SERVER, sleep } from "./browser.mjs";
const { browser, page } = await launch();
const dump = (label) => page.evaluate((label) => {
  const panel = document.querySelector("#thread-detail-secondary-panel");
  if (!panel) return label + ": no panel";
  const vis = (el) => el.getBoundingClientRect().width > 0;
  const items = [...panel.querySelectorAll("button, [role=tab], [role=menuitem], a")].filter(vis)
    .map((b) => (b.getAttribute("aria-label") ?? "") + " | " + (b.textContent ?? "").trim().slice(0, 40) + " | " + [...b.attributes].filter(a => a.name.startsWith("data-")).map(a => a.name + "=" + a.value).join(","));
  const menus = [...document.querySelectorAll("[role=menuitem], [role=option], [cmdk-item]")].filter(vis).map((b) => (b.textContent ?? "").trim().slice(0, 50));
  const xterms = [...document.querySelectorAll(".xterm")].map((el) => ({ rect: el.getBoundingClientRect().toJSON(), canvas: el.querySelectorAll("canvas").length, rows: el.querySelector(".xterm-rows")?.children.length ?? null }));
  return { label, width: panel.getBoundingClientRect().width, items, menus, xterms };
}, label);
try {
  await page.goto(SERVER + "/projects/proj_v2ia75srgp/threads/thr_fh7kmixkaj", { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(1500);
  await page.evaluate(() => [...document.querySelectorAll('button[aria-label^="Show right panel"]')].find((b) => b.getBoundingClientRect().width > 0)?.click());
  await sleep(1000);
  console.log(JSON.stringify(await dump("opened"), null, 1));
  await page.evaluate(() => [...document.querySelectorAll("button[data-panel-new-tab]")].find((b) => b.getBoundingClientRect().width > 0)?.click());
  await sleep(700);
  console.log(JSON.stringify(await dump("newtab"), null, 1));
  await page.screenshot({ path: "spike/out/explore2.png" });
} finally { await browser.close(); }
