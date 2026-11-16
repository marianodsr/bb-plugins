// Verify the "This thread" handoff (insert into the composer) at the 420 px
// side panel, record the packet's flight, interrupt a flight, and open the
// New thread dialog without submitting. Inserting writes only to this
// private browser's composer draft (and marks the comments sent).
//   node scripts/handoff-check.mjs --thread <proj>/<thread> --open <row text> --out <dir> --name <prefix>
//     [--theme light|dark] [--reduced-motion] [--interrupt] [--new-thread]
import { clickText, launch, openPage, panelWidth, shot, showPanel, sleep } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const flag = (n) => argv.includes(`--${n}`);
const [projectId, threadId] = opt("thread").split("/");
const out = opt("out");
const name = opt("name", "handoff");

const browser = await launch();
async function run() {
  const page = await openPage(browser, {
    path: `/projects/${projectId}/threads/${threadId}`,
    theme: opt("theme", "light"),
    width: Number(opt("width", "1160")),
    height: 900,
    reduced: flag("reduced-motion"),
  });
  await showPanel(page);
  console.log(`  panel ${await panelWidth(page)} px`);
  await clickText(page, '#thread-detail-secondary-panel button[aria-label="Show changed files and review comments panel"]', "");
  await clickText(page, "#thread-detail-secondary-panel [role=option]", opt("open"));
  await sleep(1800);
  // Focus the editor page (not the code) so single keys work.
  const header = await page.evaluate(() => {
    const r = document.querySelector(".rv-editor header span")?.getBoundingClientRect();
    return r ? { x: r.left + 5, y: r.top + r.height / 2 } : null;
  });
  if (header) await page.mouse.click(header.x, header.y);
  await shot(page, out, `${name}-0-before`);

  await page.keyboard.press("KeyS");
  await sleep(700);
  await shot(page, out, `${name}-1-sheet`);

  if (flag("new-thread")) {
    await page.keyboard.down("Meta");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Meta");
    await sleep(1800);
    await shot(page, out, `${name}-2-new-thread`);
    const dialog = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return d ? { text: d.textContent?.slice(0, 400), editor: d.querySelector('[contenteditable="true"], textarea')?.textContent?.slice(0, 300) } : null;
    });
    console.log("  new thread dialog:", JSON.stringify(dialog));
    await page.keyboard.press("Escape");
    await sleep(500);
    await page.keyboard.press("Escape");
    await sleep(500);
    console.log("  dialog closed:", await page.evaluate(() => document.querySelector('[role="dialog"]') === null));
    return;
  }


  // Record the packet every animation frame for 1.6 s.
  await page.evaluate(() => {
    window.__frames = [];
    const start = performance.now();
    const tick = () => {
      const layer = document.querySelector("[data-kit-handoff-layer]");
      const packet = layer?.querySelector(".rounded-full.bg-foreground");
      const r = packet?.getBoundingClientRect();
      window.__frames.push({
        t: Math.round(performance.now() - start),
        layer: Boolean(layer),
        packet: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), o: getComputedStyle(packet).opacity } : null,
      });
      if (performance.now() - start < 1600) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // "Insert into composer" is the first, highlighted target in this thread.
  await page.keyboard.press("Enter");
  const shots = [60, 140, 260, 420];
  let elapsed = 0;
  for (const [index, at] of shots.entries()) {
    await sleep(Math.max(0, at - elapsed));
    elapsed = at;
    if (flag("interrupt") && index === 1) {
      // Act mid-flight: click into the code and type. The flight must not
      // block input. (Never saved; the tab is discarded.)
      const box = await page.evaluate(() => {
        const r = document.querySelectorAll(".rv-editor .cm-line")[2]?.getBoundingClientRect();
        return r ? { x: r.left + 2, y: r.top + r.height / 2 } : null;
      });
      if (box) await page.mouse.click(box.x, box.y);
      await page.keyboard.type("typed mid-flight");
      elapsed += 200;
    }
    await shot(page, out, `${name}-2-flight-${at}ms`);
  }
  await sleep(1400);
  await shot(page, out, `${name}-3-after`);
  const frames = await page.evaluate(() => window.__frames);
  const moving = frames.filter((f) => f.packet);
  console.log(`  frames ${frames.length}, with packet ${moving.length}`);
  const sample = moving.filter((_, i) => i % Math.max(1, Math.floor(moving.length / 10)) === 0);
  console.log("  packet path:", JSON.stringify(sample.map((f) => [f.t, f.packet.x, f.packet.y, f.packet.o])));
  console.log("  layer left behind:", await page.evaluate(() => Boolean(document.querySelector("[data-kit-handoff-layer] .rounded-full.bg-foreground"))));
  const composer = await page.evaluate(() =>
    [...document.querySelectorAll('[data-promptbox-layout] [contenteditable="true"]')].map((e) => e.textContent ?? "").join("\n---\n"),
  );
  const count = (composer.match(/# Code review/g) ?? []).length;
  console.log(`  composer has the prompt ${count} time(s); starts: ${JSON.stringify(composer.slice(0, 90))}`);
  console.log("  toasts:", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.textContent?.trim()))));
  console.log("  typed during flight:", await page.evaluate(() => document.querySelector(".rv-editor .cm-content")?.textContent?.includes("typed mid-flight")));
  console.log("  sent chip:", JSON.stringify(await page.evaluate(() => document.querySelector(".rv-editor footer")?.textContent?.slice(0, 120))));
}
try {
  await run();
} finally {
  await browser.close();
}
