// The linked task as a row in a thread's context card.
export default async (page, { go, sleep, shot, log, theme, width }) => {
  await go("/plugins/task-board/board");
  const href = await page.evaluate(
    () => document.querySelector('[data-sidebar-thread-id="thr_hbjut9cnxe"] a, a[data-sidebar-thread-id="thr_hbjut9cnxe"]')?.getAttribute("href") ??
      [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).find((h) => h?.includes("thr_hbjut9cnxe")),
  );
  log("thread href", href);
  await go(href ?? "/threads/thr_hbjut9cnxe");
  await sleep(2500);
  const row = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-bb-plugin=task-board]")].find((n) => n.textContent?.includes("Live check"));
    return el ? el.getBoundingClientRect().top : null;
  });
  log("context row top:", row);
  await shot(`context-row-${theme}-${width}`);
};
