// Board open; an agent-style CLI write moves a card; capture it travelling.
import { execFile } from "node:child_process";
export default async (page, { go, sleep, shot, log }) => {
  await go("/plugins/task-board/board/p/proj_v2ia75srgp");
  const where = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll("[data-card-id]")].find((c) => c.getAttribute("aria-label")?.startsWith("Export fails"));
      const r = el?.getBoundingClientRect();
      return r ? `${Math.round(r.left)},${Math.round(r.top)}` : "none";
    });
  log("start", await where());
  execFile("bb", ["tasks", "move", "tsk_bz3g05hfei", "review"], () => {});
  const seen = [];
  for (let i = 0; i < 70; i += 1) {
    await sleep(40);
    seen.push(await where());
    if (i === 6 || i === 9) await shot(`agent-move-frame-${i}-${process.argv.includes("--reduced-motion") ? "reduced" : "full"}`);
  }
  log("positions:", seen.join(" "));
};
