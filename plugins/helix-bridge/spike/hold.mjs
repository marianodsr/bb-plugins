#!/usr/bin/env node
// Hold one editor page open in a private headless Chrome and take commands
// from files, so live checks can interleave agent turns, tools and keys on
// the same surface. Each command is a JSON file <ctl>/<n>.cmd; the answer is
// written to <ctl>/<n>.out.
//
//   node spike/hold.mjs --thread <id> --ctl <dir> [--width 1440] [--height 900]
//
// Commands: {"type":"type","text"} {"type":"press","key"} {"type":"keys","list":[...]}
// {"type":"shot","path"} {"type":"shots","path","every","count"} {"type":"focus"}
// {"type":"blur"} {"type":"screen"} (the terminal's text) {"type":"hud"}
// {"type":"reload"} {"type":"goto","url"} {"type":"eval","js"} {"type":"quit"}
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, SERVER, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const thread = opt("thread", "thr_fh7kmixkaj");
const ctl = opt("ctl", null);
if (!ctl) throw new Error("--ctl <dir> is required");
mkdirSync(ctl, { recursive: true });

const { browser, page } = await launch({ width: Number(opt("width", "1440")), height: Number(opt("height", "900")), theme: "dark" });
const textarea = () => page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
const editorUrl = `${SERVER}/plugins/helix-bridge/editor/${thread}`;

async function open(url = editorUrl) {
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForSelector("[data-helix-terminal]", { timeout: 30000 }).catch(() => {});
  await sleep(2500);
  await textarea();
}

async function run(cmd) {
  switch (cmd.type) {
    case "type":
      await page.keyboard.type(cmd.text, { delay: cmd.delay ?? 15 });
      return "ok";
    case "press":
      await page.keyboard.press(cmd.key);
      return "ok";
    case "keys":
      for (const k of cmd.list) {
        if (k.length === 1) await page.keyboard.type(k);
        else await page.keyboard.press(k);
        await sleep(cmd.gap ?? 40);
      }
      return "ok";
    case "shot":
      await page.screenshot({ path: cmd.path });
      return cmd.path;
    case "shots": {
      const out = [];
      for (let i = 0; i < (cmd.count ?? 6); i += 1) {
        const path = cmd.path.replace(/\.png$/u, `-${String(i).padStart(2, "0")}.png`);
        await page.screenshot({ path });
        out.push(path);
        await sleep(cmd.every ?? 120);
      }
      return out.join("\n");
    }
    case "focus":
      await textarea();
      return "ok";
    case "blur":
      // As when the user clicks bb's composer: the terminal loses focus.
      await page.evaluate(() => {
        document.querySelector("[data-helix-terminal] textarea")?.blur();
        document.body.focus();
      });
      return "ok";
    case "screen":
      // Needs the `hud` setting (the surface exposes its text only then).
      return page.evaluate(async () => (window.__helixScreen ? await window.__helixScreen() : "(set hud to read the screen)"));
    case "hud":
      return JSON.stringify(await page.evaluate(() => window.__helixHud?.snapshot() ?? null));
    case "eval":
      return JSON.stringify(await page.evaluate(cmd.js));
    case "reload":
      await open();
      return "ok";
    case "goto":
      await open(cmd.url);
      return "ok";
    default:
      return `unknown ${cmd.type}`;
  }
}

page.on("console", (m) => {
  if (m.type() === "error") console.log(`console: ${m.text().slice(0, 200)}`);
});
await open();
writeFileSync(join(ctl, "ready"), String(Date.now()));
let quit = false;
while (!quit) {
  const files = readdirSync(ctl).filter((f) => f.endsWith(".cmd")).sort();
  for (const file of files) {
    const id = file.slice(0, -4);
    const cmd = JSON.parse(readFileSync(join(ctl, file), "utf8"));
    renameSync(join(ctl, file), join(ctl, `${id}.done`));
    if (cmd.type === "quit") {
      quit = true;
      writeFileSync(join(ctl, `${id}.out`), "bye");
      break;
    }
    let answer;
    try {
      answer = await run(cmd);
    } catch (error) {
      answer = `error: ${String(error)}`;
    }
    writeFileSync(join(ctl, `${id}.out`), String(answer));
  }
  await sleep(30);
}
await browser.close();
if (existsSync(join(ctl, "ready"))) renameSync(join(ctl, "ready"), join(ctl, "closed"));
