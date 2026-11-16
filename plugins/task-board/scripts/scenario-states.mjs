// Capture the board's states for review. Writes <state>-<theme>-<width>.png.
export default async (page, { go, sleep, shot, log, theme, width }) => {
  const name = (state) => `${state}-${theme}-${width}`;
  const focusBoard = () =>
    page.evaluate(() => document.querySelector("[data-bb-plugin=task-board] [data-card-id][tabindex='0']")?.focus());
  const press = async (key) => {
    await page.keyboard.press(key);
    await sleep(350);
  };

  await go("/plugins/task-board/board/p/proj_v2ia75srgp");
  // Inline create: N on the board, type, then leave it open.
  await focusBoard();
  await press("n");
  await page.keyboard.type("Write the release notes", { delay: 5 });
  await sleep(200);
  await shot(name("create"));
  await press("Escape");

  // Search.
  await press("/");
  await page.keyboard.type("auth", { delay: 5 });
  await sleep(400);
  await shot(name("search"));
  await press("Escape");
  await press("Escape");

  // Filter menu.
  await page.evaluate(() => document.activeElement?.blur());
  await press("f");
  await sleep(200);
  await shot(name("filter"));
  await press("Escape");

  // Shortcut sheet.
  await press("?");
  await sleep(300);
  await shot(name("shortcuts"));
  await press("Escape");

  // List view, then back.
  await press("v");
  await sleep(600);
  await shot(name("list"));
  await press("v");
  await sleep(500);

  // Lane menu (settings button of the first lane).
  if (width > 600) {
    await page.evaluate(() => document.querySelector("[aria-label='To do lane options']")?.click());
    await sleep(400);
    await shot(name("lane-menu"));
    await press("Escape");
  }

  // All projects.
  await go("/plugins/task-board/board/all");
  await shot(name("all"));

  // Linked task detail with the live thread chat.
  await go("/plugins/task-board/board/task/tsk_a5lk4dbovf");
  await sleep(2500);
  await shot(name("detail-linked"));
  log(name("done"));
};
