// node scripts/open-file.mjs <thread path> <file> <out dir> <name> [theme] [width] [--keep]
import { closeTabs, launch, openFile, openPage, shot, showPanel, sleep } from "./lib.mjs";
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [path, file, out, name, theme = "light", width = "1440"] = args;
const browser = await launch();
try {
  const page = await openPage(browser, { path, theme, width: Number(width) });
  await showPanel(page);
  console.log("closed stale:", await closeTabs(page, ["session.ts.reviewspike"]));
  await openFile(page, file);
  await sleep(1500);
  await shot(page, out, name);
  console.log(JSON.stringify(await page.evaluate(() => ({ editors: document.querySelectorAll(".rv-editor .cm-editor").length }))));
  if (!process.argv.includes("--keep")) console.log("closed:", await closeTabs(page, [file.slice(file.lastIndexOf("/") + 1)]));
} finally { await browser.close(); }
