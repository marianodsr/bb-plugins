#!/usr/bin/env node
// Are glyphs drawn identically wherever they land? Types a row of one
// character into a scratch buffer and measures how far the row's ink profile
// is from repeating every cell (0 = every copy identical). Fractional cells
// with the WebGL atlas's NEAREST sampling make copies differ: jagged text.
// Runs at several device pixel ratios, WebGL with and without the cell
// snapping (debug switch) and the DOM renderer as the reference.
//
//   node spike/dpr-check.mjs [--thread <id>] [--dprs 1,1.5,2,3] [--shots spike/out]
import { writeFileSync } from "node:fs";
import { launch, SERVER, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const thread = opt("thread", "thr_fh7kmixkaj");
const dprs = opt("dprs", "1,1.5,2,3").split(",").map(Number);
const shots = opt("shots", "spike/out");
const glyph = "i";

async function run(dpr, variant) {
  const { browser, page } = await launch({ width: 1600, height: 700, theme: "dark" });
  try {
    await page.setViewport({ width: 1600, height: 700, deviceScaleFactor: dpr });
    await page.evaluateOnNewDocument((v) => {
      localStorage.setItem("helix-bridge.tree.visible", "0");
      localStorage.setItem("helix-bridge.debug.renderer", v === "dom" ? "dom" : "webgl");
      if (v === "webgl-nosnap") localStorage.setItem("helix-bridge.debug.nosnap", "1");
      else localStorage.removeItem("helix-bridge.debug.nosnap");
    }, variant);
    await page.goto(`${SERVER}/plugins/helix-bridge/editor/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForSelector("[data-helix-terminal]", { timeout: 30000 });
    await sleep(3500);
    await page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
    await page.keyboard.press("Escape");
    // A file of nothing but rows of one glyph: any text row is the pattern.
    await page.keyboard.type(":o /Users/marianodsr/.bb/thread-storage/thr_fh7kmixkaj/spike/glyphs.txt");
    await page.keyboard.press("Enter");
    await sleep(1500);
    const geo = await page.evaluate(() => {
      const el = document.querySelector("[data-helix-terminal]");
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { x: r.x, y: r.y, width: r.width, cellW: parseFloat(cs.getPropertyValue("--term-cell-width")), rowH: parseFloat(cs.getPropertyValue("--term-row-height")), dpr: window.devicePixelRatio };
    });
    // A text row in the middle of the pane.
    const clip = { x: geo.x, y: geo.y + geo.rowH * 10, width: Math.min(geo.width, geo.cellW * 80), height: geo.rowH };
    if (argv.includes("--full")) console.log(JSON.stringify({ geo, clip }));
    if (argv.includes("--full")) await page.screenshot({ path: `${shots}/dpr-${dpr}-${variant}-full.png` });
    // A clipped capture re-lays out the page and can come back blank for a
    // WebGL canvas: capture the page and crop it here.
    const png = await page.evaluate(
      async (full, c, scale) => {
        const img = new Image();
        img.src = `data:image/png;base64,${full}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(c.width * scale);
        canvas.height = Math.round(c.height * scale);
        canvas.getContext("2d").drawImage(img, Math.round(c.x * scale), Math.round(c.y * scale), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png").split(",")[1];
      },
      await page.screenshot({ encoding: "base64", captureBeyondViewport: false }),
      clip,
      dpr,
    );
    writeFileSync(`${shots}/dpr-${dpr}-${variant}.png`, Buffer.from(png, "base64"));
    const profile = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      const px = x.getImageData(0, 0, img.width, img.height).data;
      const col = new Array(img.width).fill(0);
      for (let yy = 0; yy < img.height; yy += 1)
        for (let xx = 0; xx < img.width; xx += 1) {
          const i = (yy * img.width + xx) * 4;
          col[xx] += (px[i] + px[i + 1] + px[i + 2]) / 3;
        }
      return col;
    }, png);
    // Background level per column = the minimum; ink = above it.
    const floor = Math.min(...profile);
    const ink = profile.map((v) => v - floor);
    const period = geo.cellW * dpr;
    const shift = Math.round(period);
    // The span where the glyphs are: columns with ink, minus the gutter at the left.
    const lit = ink.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    const start = lit[Math.floor(lit.length * 0.3)] ?? 0;
    const end = (lit[lit.length - 1] ?? 0) - shift;
    let diff = 0;
    let sum = 0;
    for (let i = start; i < end; i += 1) {
      diff += Math.abs(ink[i] - ink[i + shift]);
      sum += ink[i];
    }
    return { dpr, variant, cellDevicePx: Math.round(period * 100) / 100, mismatch: sum > 0 ? Math.round((diff / sum) * 1000) / 1000 : null };
  } finally {
    await browser.close();
  }
}

const results = [];
for (const dpr of dprs) for (const variant of ["webgl-nosnap", "webgl", "dom"]) results.push(await run(dpr, variant));
writeFileSync(`${shots}/dpr-check.json`, JSON.stringify(results, null, 1));
console.log("dpr\tvariant\t\tcell (device px)\tmismatch (0 = identical copies)");
for (const r of results) console.log(`${r.dpr}\t${r.variant.padEnd(14)}\t${r.cellDevicePx}\t\t${r.mismatch}`);
