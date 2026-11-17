import { launch, SERVER, sleep } from "./browser.mjs";
const { browser, page } = await launch();
try {
  await page.goto(SERVER + "/projects/proj_v2ia75srgp/threads/thr_fh7kmixkaj", { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(1500);
  await page.evaluate(() => [...document.querySelectorAll('button[aria-label^="Show right panel"]')].find((b) => b.getBoundingClientRect().width > 0)?.click());
  await sleep(800);
  await page.evaluate(() => [...document.querySelectorAll("#thread-detail-secondary-panel button")].find((b) => b.textContent.trim() === "keyecho spike")?.click());
  await sleep(1500);
  const info = await page.evaluate(() => {
    const panel = document.querySelector("#thread-detail-secondary-panel");
    const walk = (el, depth) => {
      if (depth > 9) return [];
      const r = el.getBoundingClientRect();
      const line = `${"  ".repeat(depth)}${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} .${String(el.className).slice(0, 70)} [${[...el.attributes].filter(a => a.name.startsWith("data-") || a.name === "role" || a.name === "tabindex").map(a => a.name + "=" + a.value.slice(0, 30)).join(",")}] ${Math.round(r.width)}x${Math.round(r.height)}`;
      return [line, ...[...el.children].slice(0, 6).flatMap((c) => walk(c, depth + 1))];
    };
    const term = panel.querySelector(".xterm, canvas, textarea");
    let root = term; for (let i = 0; i < 6 && root?.parentElement; i++) root = root.parentElement;
    return { found: term?.tagName, tree: root ? walk(root, 0).slice(0, 80) : walk(panel, 0).slice(0, 80), globals: Object.keys(window).filter(k => /term|ghostty|xterm/i.test(k)) };
  });
  console.log(info.found, info.globals); console.log(info.tree.join("\n"));
  await page.screenshot({ path: "spike/out/explore3.png" });
} finally { await browser.close(); }
