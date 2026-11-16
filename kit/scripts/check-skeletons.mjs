// Measure every Skeleton in the gallery's probe block at 1440 and 420 px.
import puppeteer from "puppeteer-core";
import { readdirSync } from "node:fs"; import { join } from "node:path"; import { homedir } from "node:os";
const base = join(homedir(), ".cache/puppeteer/chrome-headless-shell"); const v = readdirSync(base).sort().pop();
const exe = join(base, v, readdirSync(join(base, v)).find((d) => d.startsWith("chrome")), "chrome-headless-shell");
const b = await puppeteer.launch({ executablePath: exe, headless: true });
for (const width of [1440, 420]) {
  const p = await b.newPage();
  await p.setViewport({ width, height: 1000 });
  await p.goto("http://127.0.0.1:38886/plugins/kit-gallery/gallery", { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1500));
  const out = await p.evaluate(() => {
    const probe = document.querySelector("[data-skeleton-probe]");
    probe.scrollIntoView();
    const rows = [...probe.querySelectorAll('[role="status"] > div')].map((row) =>
      [...row.querySelectorAll(".kit-skeleton")].map((s) => Math.round(s.getBoundingClientRect().width)).join("/"));
    const parents = [...probe.querySelectorAll("[data-parent]")].map((el) =>
      `${el.dataset.parent}(${Math.round(el.getBoundingClientRect().width)}): ` +
      [...el.querySelectorAll(".kit-skeleton")].map((s) => Math.round(s.getBoundingClientRect().width)).join("/"));
    const s = probe.querySelector(".kit-skeleton");
    return { rows, parents, opacity: getComputedStyle(s).opacity };
  });
  console.log(width, JSON.stringify(out));
  await p.screenshot({ path: `/Users/marianodsr/projects/bb-plugins/docs/screenshots/kit-gallery/skeletons-light-${width}.png` });
}
await b.close();
