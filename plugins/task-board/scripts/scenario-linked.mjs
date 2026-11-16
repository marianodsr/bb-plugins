// A linked task opened from the board (Enter on its card): the task panel
// with its thread and live transcript. Also writes the deep-link view.
export default async (page, { go, sleep, shot, log, theme, width }) => {
  const task = process.env.TASK;
  await go("/plugins/task-board/board/p/proj_v2ia75srgp");
  await page.evaluate(() => document.querySelector("[data-bb-plugin=task-board] [data-card-id][tabindex='0']")?.focus());
  await page.keyboard.press("Enter");
  await sleep(2500);
  log("opened:", await page.evaluate(() => document.querySelector("h1")?.textContent));
  await shot(`detail-linked-${theme}-${width}`);
  await shot(`detail-${theme}-${width}`);
  await go(`/plugins/task-board/board/task/${task}`);
  await sleep(2500);
  log("deep link sheet:", await page.evaluate(() => Boolean(document.querySelector("[data-bb-plugin=task-board] [role=dialog][aria-label=Task]"))));
  await shot(`deeplink-${theme}-${width}`);
};
