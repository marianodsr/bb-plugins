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
    const el = document.querySelector("#thread-detail-secondary-panel .xterm");
    const isTerm = (c) => c && typeof c === "object" && c.buffer && typeof c.onRender === "function" && c.options;
    const seen = new Set();
    for (let n = el; n; n = n.parentElement) {
      const key = Object.keys(n).find((k) => k.startsWith("__reactFiber"));
      if (!key) continue;
      for (let f = n[key], i = 0; f && i < 40; i++, f = f.return) {
        for (let h = f.memoizedState, j = 0; h && j < 60; j++, h = h.next) {
          const v = h.memoizedState;
          for (const c of [v, v?.current, v?.current?.terminal, v?.current?.term, v?.terminal]) {
            if (isTerm(c) && !seen.has(c)) { seen.add(c); window.__spikeTerm = c; }
          }
        }
      }
      if (seen.size) break;
    }
    const t = window.__spikeTerm;
    if (!t) return { found: false };
    const lines = []; for (let i = 0; i < 6; i++) lines.push(t.buffer.active.getLine(i)?.translateToString(true));
    return { found: true, count: seen.size, cols: t.cols, rows: t.rows, options: { macOptionIsMeta: t.options.macOptionIsMeta, macOptionClickForcesSelection: t.options.macOptionClickForcesSelection, fontSize: t.options.fontSize, fontFamily: t.options.fontFamily, scrollback: t.options.scrollback, rightClickSelectsWord: t.options.rightClickSelectsWord, allowProposedApi: t.options.allowProposedApi, screenReaderMode: t.options.screenReaderMode, cursorBlink: t.options.cursorBlink, smoothScrollDuration: t.options.smoothScrollDuration, minimumContrastRatio: t.options.minimumContrastRatio, drawBoldTextInBrightColors: t.options.drawBoldTextInBrightColors }, lines, modes: t.modes };
  });
  console.log(JSON.stringify(info, null, 1));
} finally { await browser.close(); }
