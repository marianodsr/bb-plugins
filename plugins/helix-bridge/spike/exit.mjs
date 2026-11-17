#!/usr/bin/env node
// Quit the real Helix from the editor page in each way and check what the
// app does: clean exits go back to the thread with no terminal left and the
// composer focused; a crash shows the exit report.
//
//   node spike/exit.mjs --thread <threadId> --project <projectId> [--how ":q" | ":q!" | ":wq" | ":cq" | bbclose | kill]
import { execFileSync } from "node:child_process";
import { launch, SERVER, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const thread = opt("thread", "thr_fh7kmixkaj");
const project = opt("project", "proj_v2ia75srgp");
const how = opt("how", ":q");
const shot = opt("shot", null);

const helixTerminals = () =>
  execFileSync("bb", ["terminal", "list", "--thread", thread], { encoding: "utf8" })
    .split("\n")
    .filter((l) => /\bHelix\b/u.test(l) && /running|starting|exited/u.test(l))
    .map((l) => l.trim().replace(/\s+/gu, " "));

const { browser, page } = await launch({ width: 1440, height: 900, theme: "dark" });
const result = { how };
await page.evaluateOnNewDocument(() => {
  window.__keyLog = [];
  window.addEventListener("keydown", (e) => {
    const a = document.activeElement;
    const where = a?.closest?.("[data-helix-terminal]") ? "terminal" : a?.closest?.("[data-promptbox-layout]") ? "composer" : `${a?.tagName}`;
    window.__keyLog.push(`${e.key}@${where}`);
  }, true);
  window.__wsLog = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      if (!String(url).includes("/ws/terminals/")) return;
      this.addEventListener("message", (e) => {
        const text = String(e.data);
        if (text.includes('"type":"exited"')) window.__wsLog.push(JSON.parse(text).session);
      });
      const send = this.send.bind(this);
      this.send = (data) => {
        try {
          const m = JSON.parse(data);
          if (m.type === "input") (window.__sentLog ??= []).push(atob(m.dataBase64).replace(/\x1b/gu, "ESC").replace(/\r/gu, "CR"));
        } catch {}
        return send(data);
      };
    }
  };
});
try {
  await page.goto(`${SERVER}/plugins/helix-bridge/editor/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForSelector("[data-helix-terminal] canvas, [data-helix-terminal] .term-grid", { timeout: 30000 });
  await sleep(3500); // Helix starts and paints
  result.before = { path: await page.evaluate(() => location.pathname), terminals: helixTerminals() };
  // Safety: our instance must be bound to our thread by its terminal; never
  // drive an instance that mapped elsewhere.
  const ours = execFileSync("bb", ["hx", "list"], { encoding: "utf8" }).split("\n").find((l) => l.includes(`-> ${thread}`) && l.includes("(terminal)"));
  result.instance = ours ?? null;
  if (!ours) {
    for (const t of helixTerminals()) execFileSync("bb", ["terminal", "close", t.split(" ")[0]]);
    throw new Error("our Helix is not bound to our thread by its terminal; closed it");
  }
  await page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
  if (how === "bbclose") {
    const id = helixTerminals()[0]?.split(" ")[0];
    result.closed = id;
    execFileSync("bb", ["terminal", "close", id]);
  } else if (how === "kill") {
    // Only our own instance: the one bound to this thread by its terminal.
    const line = execFileSync("bb", ["hx", "list"], { encoding: "utf8" }).split("\n").find((l) => l.includes(`-> ${thread}`) && l.includes("(terminal)"));
    const pid = /pid (\d+)/u.exec(line ?? "")?.[1];
    if (!pid) throw new Error("no instance of ours to kill");
    result.killed = pid;
    execFileSync("kill", ["-9", pid]);
  } else {
    await page.keyboard.press("Escape");
    for (const part of how.split("|")) {
      await page.keyboard.type(part);
      await page.keyboard.press("Enter");
      await sleep(400);
    }
  }
  await sleep(2500);
  result.after = {
    path: await page.evaluate(() => location.pathname),
    surface: await page.evaluate(() => Boolean(document.querySelector("[data-helix-terminal]"))),
    exitReport: await page.evaluate(() => document.querySelector("[data-helix-exit]")?.innerText ?? null),
    composerFocused: await page.evaluate(() => Boolean(document.activeElement?.closest?.("[data-promptbox-layout]"))),
    terminals: helixTerminals(),
    exited: await page.evaluate(() => (window.__wsLog ?? []).map((s) => ({ exitCode: s.exitCode, closeReason: s.closeReason }))),
  };
  if (shot) await page.screenshot({ path: shot });
} finally {
  await browser.close();
}
console.log(JSON.stringify(result, null, 1));
