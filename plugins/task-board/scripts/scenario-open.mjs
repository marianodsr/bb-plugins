// Board, then keyboard: focus the first card, move down, open with Enter.
export default async (page, { go, sleep, shot, log }) => {
  await go("/plugins/task-board/board/p/proj_v2ia75srgp");
  const theme = await page.evaluate(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));
  const width = page.viewport().width;
  await shot(`board-${theme}-${width}`);
  // Focus the board's tab stop (first card), then j and Enter.
  await page.evaluate(() => document.querySelector("[data-bb-plugin=task-board] [data-card-id][tabindex='0']")?.focus());
  await page.keyboard.press("j");
  await sleep(250);
  log("focused:", await page.evaluate(() => document.activeElement?.getAttribute("aria-label")));
  await page.keyboard.press("Enter");
  await sleep(1500);
  log("panel heading:", await page.evaluate(() => document.querySelector("h1")?.textContent));
  await shot(`detail-${theme}-${width}`);
};
