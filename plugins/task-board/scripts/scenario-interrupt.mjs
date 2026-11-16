// Interrupt a handoff mid-flight: New thread (flies to the dialog), then
// Escape while the packet travels. Sends nothing.
export default async (page, { go, sleep, shot, log, theme, width }) => {
  await go(`/plugins/task-board/board/task/${process.env.TASK}`);
  await sleep(1500);
  const rect = (sel) =>
    page.evaluate((sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r && r.width > 0 ? `${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)}` : "none";
    }, sel);
  await page.evaluate(() =>
    [...document.querySelectorAll("[data-bb-plugin=task-board] button")].find((b) => b.textContent?.startsWith("Start work"))?.click(),
  );
  await sleep(500);
  log(
    "sheet new-thread row:",
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-radix-popper-content-wrapper] button, [data-radix-popper-content-wrapper] [role=option]")];
      const row = rows.find((el) => /new thread/i.test(el.textContent ?? ""));
      row?.click();
      return row ? row.textContent?.trim().slice(0, 40) : `no row among ${rows.length}`;
    }),
  );
  const trail = [];
  for (let i = 0; i < 14; i += 1) {
    await sleep(35);
    trail.push(await rect("[data-kit-handoff-layer] > div.rounded-full"));
    if (i === 7) {
      await shot(`handoff-interrupt-before-${theme}-${width}`);
      await page.keyboard.press("Escape");
      trail.push("ESC");
    }
  }
  log("packet:", trail.join(" "));
  await sleep(1500);
  log(
    "after:",
    JSON.stringify(
      await page.evaluate(() => ({
        layers: document.querySelectorAll("[data-kit-handoff-layer]").length,
        dialog: Boolean(document.querySelector("[data-kit-handoff-dialog]")),
        dimmed: [...document.querySelectorAll("[data-bb-plugin=task-board] *")].filter((el) => Number(getComputedStyle(el).opacity) < 0.99 && el.closest("article")).length,
        focus: document.activeElement?.textContent?.trim().slice(0, 30) ?? null,
      })),
    ),
  );
  await shot(`handoff-interrupt-after-${theme}-${width}`);
};
