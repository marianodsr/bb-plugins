#!/usr/bin/env node
// Is the editor surface drawn with the font style Ghostty uses? Renders the
// same text with a style and with Regular, in WebGL and in the DOM renderer,
// in both panes (Helix and the yazi tree), and compares ink coverage: pixels
// clearly different from the background, per cell. Uses this browser's debug
// switches only (localStorage), never a setting.
//
//   node spike/font-check.mjs [--thread <id>] [--style Bold] [--file README.md] [--shots <dir>]
import { writeFileSync } from "node:fs";
import { launch, SERVER, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const thread = opt("thread", "thr_fh7kmixkaj");
const style = opt("style", ""); // "" is Ghostty's own font-style
const file = opt("file", "README.md");
const shots = opt("shots", "spike/out");

async function measure(renderer, fontStyle) {
  const { browser, page } = await launch({ width: 1800, height: 900, theme: "dark" });
  try {
    await page.evaluateOnNewDocument(
      (r, s) => {
        localStorage.setItem("helix-bridge.debug.renderer", r);
        if (s) localStorage.setItem("helix-bridge.debug.fontStyle", s);
        else localStorage.removeItem("helix-bridge.debug.fontStyle");
        localStorage.setItem("helix-bridge.tree.visible", "1");
      },
      renderer,
      fontStyle,
    );
    await page.goto(`${SERVER}/plugins/helix-bridge/editor/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForSelector("[data-helix-terminal]", { timeout: 30000 });
    await sleep(3500);
    await page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
    await page.keyboard.press("Escape");
    await page.keyboard.type(`:o ${file}`);
    await page.keyboard.press("Enter");
    await sleep(800);
    await page.keyboard.type("gg");
    await sleep(1500);
    const info = await page.evaluate(() => {
      const el = document.querySelector("[data-helix-terminal]");
      const family = el ? getComputedStyle(el).getPropertyValue("--term-font-family") : "";
      const faces = [...document.fonts].filter((f) => f.family.includes("Helix Bridge")).map((f) => `${f.family} ${f.weight} ${f.style}: ${f.status}`);
      return { family, faces, mode: el?.querySelector("canvas.term-gpu-canvas:not([hidden])") ? "webgl" : "dom" };
    });
    const result = { renderer, style: fontStyle || "(Ghostty's)", ...info, panes: {} };
    for (const [name, selector] of [["editor", "[data-helix-terminal]"], ["tree", "[data-helix-tree-terminal]"]]) {
      const box = await page.evaluate((sel) => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
      }, selector);
      if (!box) continue;
      const path = `${shots}/font-${renderer}-${(fontStyle || "ghostty").toLowerCase()}-${name}.png`;
      // Wait until the pane is painted and two captures agree.
      let png = "";
      let previous = -1;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        // Crop a full capture: a clipped one can come back blank for WebGL.
        png = await page.evaluate(
          async (full, c) => {
            const img = new Image();
            img.src = `data:image/png;base64,${full}`;
            await img.decode();
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(c.width);
            canvas.height = Math.round(c.height);
            canvas.getContext("2d").drawImage(img, Math.round(c.x), Math.round(c.y), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL("image/png").split(",")[1];
          },
          await page.screenshot({ encoding: "base64", captureBeyondViewport: false }),
          box,
        );
        const quick = await page.evaluate(async (data) => {
          const img = new Image();
          img.src = `data:image/png;base64,${data}`;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const x = c.getContext("2d", { willReadFrequently: true });
          x.drawImage(img, 0, 0);
          const px = x.getImageData(0, 0, img.width, img.height).data;
          let lit = 0;
          for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 300) lit += 1;
          return lit;
        }, png);
        if (quick > 0 && quick === previous) break;
        previous = quick;
        await sleep(500);
      }
      writeFileSync(path, Buffer.from(png, "base64"));
      const cells = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        const row = parseFloat(getComputedStyle(el).getPropertyValue("--term-row-height")) || 20;
        const probe = document.createElement("span");
        probe.textContent = "M".repeat(100);
        probe.style.cssText = `font-family:${getComputedStyle(el).getPropertyValue("--term-font-family")};font-size:${getComputedStyle(el).getPropertyValue("--term-font-size")};position:fixed;visibility:hidden;white-space:pre`;
        document.body.appendChild(probe);
        const width = probe.getBoundingClientRect().width / 100;
        probe.remove();
        return { width, row };
      }, selector);
      const ink = await page.evaluate(async (data) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const { data: px } = ctx.getImageData(0, 0, img.width, img.height);
        // The background is the most common colour.
        const counts = new Map();
        for (let i = 0; i < px.length; i += 16) {
          const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const br = bg >> 16, bgG = (bg >> 8) & 255, bb = bg & 255;
        let inked = 0;
        for (let i = 0; i < px.length; i += 4) {
          const d = Math.abs(px[i] - br) + Math.abs(px[i + 1] - bgG) + Math.abs(px[i + 2] - bb);
          if (d > 120) inked += 1;
        }
        return { inked, total: px.length / 4, width: img.width, height: img.height };
      }, png);
      const cellCount = Math.floor(ink.width / cells.width) * Math.floor(ink.height / cells.row);
      result.panes[name] = { inkPixels: ink.inked, inkPerCell: Math.round((ink.inked / cellCount) * 100) / 100, cells: cellCount, shot: path };
    }
    return result;
  } finally {
    await browser.close();
  }
}

const results = [];
for (const renderer of opt("renderers", "webgl,dom").split(",")) {
  for (const s of ["Regular", style]) results.push(await measure(renderer, s));
}
writeFileSync(`${shots}/font-check.json`, JSON.stringify(results, null, 1));
for (const r of results) {
  console.log(`${r.renderer.padEnd(6)} (drawn: ${r.mode}) style ${r.style.padEnd(12)} editor ${r.panes.editor?.inkPerCell ?? "-"} ink/cell, tree ${r.panes.tree?.inkPerCell ?? "-"} ink/cell`);
  console.log(`        family ${r.family.trim()}`);
  for (const f of r.faces) console.log(`        ${f}`);
}
for (const renderer of ["webgl", "dom"]) {
  const [regular, styled] = results.filter((r) => r.renderer === renderer);
  for (const pane of ["editor", "tree"]) {
    const a = regular?.panes[pane]?.inkPerCell;
    const b = styled?.panes[pane]?.inkPerCell;
    if (a && b) console.log(`${renderer} ${pane}: ${style || "Ghostty's style"} / Regular = ${(b / a).toFixed(3)}`);
  }
}
