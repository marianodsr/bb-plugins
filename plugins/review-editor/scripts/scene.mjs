// Drive a Review Editor scene and screenshot it.
//   node scripts/scene.mjs --thread <projId>/<threadId> --out <dir> --name <prefix>
//     [--theme light|dark] [--width 1920] [--height 1000] [--steps "review;open:session.ts;keys:...;shot:x"]
// Steps (semicolon separated):
//   review              select the Review tab
//   open:<text>         click the Review tab row whose text includes <text>
//   tab:<title>         select a panel tab by title
//   keys:<k1>,<k2>      press keys (puppeteer names, e.g. BracketRight, Escape, KeyC)
//   type:<text>         type text
//   click:<sel>|<text>  click the first element matching selector containing text
//   eval:<js>           run js in the page, print the result
//   wait:<ms>
//   shot:<suffix>       screenshot <name>-<suffix>.png
//   close:<title>       close a panel tab
import { appendFileSync } from "node:fs";
import { clickText, closeTabs, launch, openPage, panelWidth, selectTab, shot, showPanel, sleep } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const [projectId, threadId] = opt("thread").split("/");
const out = opt("out", "docs/screenshots/review-editor/scratch");
const name = opt("name", "scene");
const theme = opt("theme", "light");
const width = Number(opt("width", "1920"));
const height = Number(opt("height", "1000"));
const steps = opt("steps", "review;shot:review").split(";").filter(Boolean);

const browser = await launch();
try {
  const page = await openPage(browser, { path: `/projects/${projectId}/threads/${threadId}`, theme, width, height, reduced: argv.includes("--reduced-motion"), baseRef: opt("base-ref", null) });
  await showPanel(page);
  console.log(`  panel width ${await panelWidth(page)} px`);
  for (const step of steps) {
    const [kind, ...rest] = step.split(":");
    const arg = rest.join(":");
    if (kind === "review") await clickText(page, '#thread-detail-secondary-panel button[aria-label="Show changed files and review comments panel"]', "");
    else if (kind === "tab") await selectTab(page, arg);
    else if (kind === "open") await clickText(page, "#thread-detail-secondary-panel [role=option]", arg);
    else if (kind === "keys") {
      for (const combo of arg.split(",")) {
        const parts = combo.split("+");
        const key = parts.pop();
        for (const mod of parts) await page.keyboard.down(mod);
        await page.keyboard.press(key);
        for (const mod of parts.reverse()) await page.keyboard.up(mod);
        await sleep(250);
      }
    }
    else if (kind === "append") {
      // Write to a scratch file on disk, as an agent or terminal would.
      const [file, text] = arg.split("|");
      if (!file.includes("/.scratch/")) throw new Error("append only writes scratch files");
      appendFileSync(file, text.replaceAll("\\n", "\n"));
      await sleep(300);
    }
    else if (kind === "mouse") {
      // A real mouse click (mousedown, mouseup, click) at the element's centre.
      const [sel, nth = "0"] = arg.split("@");
      const box = await page.evaluate((sel, nth) => {
        const el = [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().height > 0)[Number(nth)];
        const r = el?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      }, sel, nth);
      if (box) await page.mouse.click(box.x, box.y); else console.log(`  nothing at ${arg}`);
      await sleep(400);
    }
    else if (kind === "clickline") {
      // Click into the editor at the start of a one-based line.
      const box = await page.evaluate((n) => {
        const line = document.querySelectorAll(".rv-editor .cm-line")[Number(n) - 1];
        const r = line?.getBoundingClientRect();
        return r ? { x: r.left + 4, y: r.top + r.height / 2 } : null;
      }, arg);
      if (box) await page.mouse.click(box.x, box.y); else console.log(`  no line ${arg}`);
      await sleep(300);
    }
    else if (kind === "type") await page.keyboard.type(arg, { delay: 10 });
    else if (kind === "click") { const [sel, text] = arg.split("|"); await clickText(page, sel, text ?? ""); }
    else if (kind === "eval") console.log("  eval:", JSON.stringify(await page.evaluate(arg)));
    else if (kind === "wait") await sleep(Number(arg));
    else if (kind === "shot") await shot(page, out, `${name}-${arg}`);
    else if (kind === "close") console.log("  closed", await closeTabs(page, [arg]));
    else console.log(`  unknown step ${step}`);
  }
} finally {
  await browser.close();
}
