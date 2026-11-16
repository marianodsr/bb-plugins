export default async (page, { go, sleep, log, shot, theme, width }) => {
  await go("/plugins/task-board/board/task/tsk_45seoypcfk");
  await sleep(3000);
  log("sheet:", await page.evaluate(() => Boolean(document.querySelector("[data-bb-plugin=task-board] [role=dialog][aria-label=Task]"))));
  log("h1:", await page.evaluate(() => document.querySelector("h1")?.textContent));
  await shot(`deeplink-${theme}-${width}`);
};
