#!/usr/bin/env node
// Enter on a file in the tree -> the first output from Helix that names it.
// The page timestamps the keydown and every terminal output message, so the
// number is what the user waits for, opener and all.
//
//   node spike/tree-open-latency.mjs [--thread <id>] [--rounds 6]
import { launch, SERVER, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const thread = opt("thread", "thr_fh7kmixkaj");
const rounds = Number(opt("rounds", "6"));
const { browser, page } = await launch({ width: 1800, height: 900, theme: "dark" });
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("helix-bridge.tree.visible", "1");
  window.__out = [];
  window.__enterAt = 0;
  window.addEventListener("keydown", (e) => { if (e.key === "Enter") window.__enterAt = performance.now(); }, true);
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      if (!String(url).includes("/ws/terminals/")) return;
      this.addEventListener("message", (e) => {
        const text = String(e.data);
        if (!text.includes('"output"')) return;
        try { window.__out.push({ t: performance.now(), text: atob(JSON.parse(text).chunk.dataBase64) }); } catch {}
        if (window.__out.length > 400) window.__out.splice(0, 200);
      });
    }
  };
});
const results = [];
try {
  await page.goto(`${SERVER}/plugins/helix-bridge/editor/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(4000);
  await page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
  await page.keyboard.press("Escape");
  await page.keyboard.type(":o README.md");
  await page.keyboard.press("Enter");
  await sleep(2000);
  for (let r = 0; r < rounds; r += 1) {
    // Helix redraws only what changed: names sharing a suffix (README.md, PLAN.md) would
    // never appear whole in the output, so alternate two with nothing in common.
    const [name, down] = [["something.go", 7], ["README.md", 6]][r % 2];
    if (!(await page.$("[data-helix-tree]"))) {
      await page.keyboard.down("Meta"); await page.keyboard.down("Shift"); await page.keyboard.press("y"); await page.keyboard.up("Shift"); await page.keyboard.up("Meta");
      await sleep(2000);
    }
    await page.evaluate(() => document.querySelector("[data-helix-tree-terminal] textarea")?.focus());
    await page.keyboard.type("gg");
    for (let i = 0; i < down; i += 1) { await page.keyboard.press("j"); await sleep(40); }
    await sleep(500);
    await page.evaluate(() => { window.__out = []; });
    await page.keyboard.press("Enter");
    await sleep(1500);
    const ms = await page.evaluate((n) => {
      // Escape sequences can split the name across a redraw: match on the text alone.
      const plain = (t) => t.replace(/\x1b\[[0-9;:?]*[ -\/]*[@-~]/gu, "");
      const hit = window.__out.find((o) => o.t > window.__enterAt && plain(o.text).includes(n));
      return hit ? Math.round(hit.t - window.__enterAt) : null;
    }, name);
    const state = await page.evaluate(() => ({ tree: Boolean(document.querySelector("[data-helix-tree]")), editorFocused: Boolean(document.activeElement?.closest("[data-helix-terminal]")) }));
    results.push(ms);
    console.log(`open ${name}: ${ms ?? "not seen"} ms; tree shown after: ${state.tree}; focus in editor: ${state.editorFocused}`);
  }
} finally {
  await browser.close();
}
const ok = results.filter((v) => v !== null).sort((a, b) => a - b);
console.log(`median ${ok[Math.floor(ok.length / 2)] ?? "-"} ms over ${ok.length}`);
