// Start work through the kit handoff to an existing thread; trace the packet.
//   TASK=<tsk_…> THREAD=<thr_…> [INTERRUPT=1] node scripts/drive.mjs scenario-handoff.mjs
export default async (page, { go, sleep, shot, log, theme, width }) => {
  const task = process.env.TASK;
  const thread = process.env.THREAD;
  const tag = `${theme}-${width}${process.env.INTERRUPT ? "-interrupt" : ""}`;
  await go(`/plugins/task-board/board/task/${task}`);
  await sleep(1500);
  const rect = (sel) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const r = el?.getBoundingClientRect();
      return r && r.width > 0 ? `${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)}` : "none";
    }, sel);
  if (process.env.EXPAND) {
    // Show the target thread's sidebar row by expanding its parent's children.
    log(
      "expand:",
      await page.evaluate((parent) => {
        const row = document.querySelector(`[data-sidebar-thread-id="${parent}"]`);
        const buttons = [...(row?.querySelectorAll("button") ?? [])];
        const labels = buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
        const toggle = buttons.find((b) => /expand|show|sub|child|thread/i.test(b.getAttribute("aria-label") ?? ""));
        toggle?.click();
        return { labels, clicked: toggle?.getAttribute("aria-label") ?? null };
      }, process.env.EXPAND),
    );
    await sleep(600);
  }
  log("sidebar row:", await rect(`[data-sidebar-thread-id="${thread}"]`));
  await page.keyboard.press("s");
  await sleep(500);
  await shot(`handoff-sheet-${tag}`);
  await page.keyboard.type("Task Board tools", { delay: 10 });
  await sleep(400);
  const packet = () => rect("[data-kit-handoff-layer] > div.rounded-full");
  await page.keyboard.press("Enter");
  const trail = [];
  for (let i = 0; i < 16; i += 1) {
    await sleep(40);
    trail.push(await packet());
    if (i === 6) log("landing row:", await rect(`[data-bb-plugin=task-board] [data-kit-handoff-row="${thread}"]`));
    if (i === 5 || i === 8) await shot(`handoff-flight-${i}-${tag}`);
    if (process.env.INTERRUPT && i === 7) {
      // Interrupt mid-travel: close the task (sheet or panel tab) under the packet.
      await page.keyboard.press("Escape");
      log("interrupted at", trail.at(-1));
    }
  }
  log("packet:", trail.join(" "));
  await sleep(1500);
  log(
    "leftovers:",
    JSON.stringify(
      await page.evaluate(() => ({
        layers: document.querySelectorAll("[data-kit-handoff-layer]").length,
        styledSources: [...document.querySelectorAll("[data-bb-plugin=task-board] header")]
          .filter((h) => h.style.transform || h.style.opacity)
          .map((h) => `${h.style.cssText} (computed opacity ${getComputedStyle(h).opacity}, transform ${getComputedStyle(h).transform})`),
      })),
    ),
  );
  await shot(`handoff-sent-${tag}`);
  log("toast:", await page.evaluate(() => [...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.textContent).join(" | ")));
};
