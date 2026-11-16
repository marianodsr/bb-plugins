// Pointer drag a card from To do to Review, with frames; then a keyboard move.
export default async (page, { go, sleep, shot, log }) => {
  await go("/plugins/task-board/board/p/proj_v2ia75srgp");
  const box = async (selector) =>
    page.evaluate((sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom } : null;
    }, selector);
  const order = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-bb-plugin=task-board] [data-column-index]")].map((col) =>
        [...col.querySelectorAll("[data-card-id]")].map((c) => c.getAttribute("aria-label")).join(" | "),
      ),
    );
  log("before", JSON.stringify(await order()));
  const card = await box("[data-card-id] [class*=line-clamp]:not(:empty)");
  const source = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-card-id]")].find((c) => c.getAttribute("aria-label")?.startsWith("Retry queue"));
    const r = el.getBoundingClientRect();
    return { x: r.left + 40, y: r.top + 20 };
  });
  const review = await page.evaluate(() => {
    const col = document.querySelector("[data-column-index='2']").getBoundingClientRect();
    return { x: col.left + col.width / 2, y: col.top + 60 };
  });
  void card;
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(source.x + ((review.x - source.x) * i) / steps, source.y + ((review.y - source.y) * i) / steps);
    await sleep(30);
    if (i === 6) await shot("drag-mid-light-1440");
  }
  await sleep(250);
  await shot("drag-over-review-light-1440");
  await page.mouse.up();
  await sleep(90);
  await shot("drag-drop-settling-light-1440");
  await sleep(700);
  log("after drop", JSON.stringify(await order()));

  // Cancel: pick up "Export fails", move over In progress, press Escape.
  const exp = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-card-id]")].find((c) => c.getAttribute("aria-label")?.startsWith("Export fails"));
    const r = el.getBoundingClientRect();
    return { x: r.left + 40, y: r.top + 20 };
  });
  await page.mouse.move(exp.x, exp.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(exp.x + 50 * i, exp.y - 20 * i);
    await sleep(25);
  }
  await page.keyboard.press("Escape");
  await sleep(120);
  await shot("drag-cancel-returning-light-1440");
  await page.mouse.up();
  await sleep(600);
  log("after cancel", JSON.stringify(await order()));

  // Keyboard: focus "Session refresh…", Space, ArrowRight, ArrowDown, Space.
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-card-id]")].find((c) => c.getAttribute("aria-label")?.startsWith("Session refresh"));
    el?.focus();
  });
  await page.keyboard.press("Space");
  await sleep(200);
  await page.keyboard.press("ArrowRight");
  await sleep(350);
  await shot("keyboard-lifted-light-1440");
  log("live region:", await page.evaluate(() => document.querySelector("[data-bb-plugin=task-board] [aria-live]")?.textContent));
  await page.keyboard.press("ArrowDown");
  await sleep(200);
  await page.keyboard.press("Space");
  await sleep(700);
  log("after keyboard", JSON.stringify(await order()));
  log("focused:", await page.evaluate(() => document.activeElement?.getAttribute("aria-label")));
};
