#!/usr/bin/env node
// The real fork in the real editor surface, on an instance you started and
// bound to your own thread (refuses otherwise). Needs the `hud` setting on.
//
//   node spike/real-surface.mjs --thread <threadId> [--shots <dir>]
import { execFileSync } from "node:child_process";
import { launch, SERVER, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const thread = opt("thread", "thr_fh7kmixkaj");
const shots = opt("shots", "spike/out");
const bb = (...args) => execFileSync("bb", args, { encoding: "utf8" });
const out = {};

const ours = bb("hx", "list").split("\n").find((l) => l.includes(`-> ${thread}`) && /\((terminal|explicit)\)/u.test(l));
if (!ours) throw new Error(`no Helix bound to ${thread}; start your own first`);
out.instance = ours.trim();
const state = () => bb("hx", "state", "--instance", /pid (\d+)/u.exec(ours)[1]);
const focusLine = () => /focused: (.*)/u.exec(state())?.[1] ?? null;

const { browser, page } = await launch({ width: 1440, height: 900, theme: "dark" });
const cdp = await page.createCDPSession();
const hud = () =>
  page.evaluate(() => {
    const cells = [...document.querySelectorAll("[data-helix-hud] > span")].map((s) => s.textContent);
    const o = {};
    for (let i = 0; i + 1 < cells.length; i += 2) o[cells[i]] = cells[i + 1];
    return o;
  });
const key = async (k, mods = 0, text) => {
  await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...k, modifiers: mods, ...(text ? { text } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k, modifiers: mods });
};
const typed = async (s) => {
  await page.keyboard.type(s);
  await sleep(150);
};
const enter = () => page.keyboard.press("Enter");
const esc = () => page.keyboard.press("Escape");
try {
  await page.goto(`${SERVER}/plugins/helix-bridge/editor/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForSelector("[data-helix-hud]", { timeout: 30000 });
  await sleep(2500);
  await page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
  await esc();
  await sleep(700);
  out.escapeSent = (await hud()).Sent; // "ESC" legacy, "ESC [27u" with Kitty
  // Option as Alt on a real Mac event: Option+. arrives as "≥".
  await key({ key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, location: 1 }, 1);
  await key({ key: "≥", code: "Period", windowsVirtualKeyCode: 190 }, 1, "≥");
  await sleep(700);
  out.optionPeriodSent = (await hud()).Sent;
  await key({ key: "Dead", code: "KeyI", windowsVirtualKeyCode: 73 }, 1);
  await sleep(700);
  out.optionDeadISent = (await hud()).Sent;
  await esc();

  // Position while moving and switching files.
  await typed("gg");
  for (let i = 0; i < 9; i += 1) await page.keyboard.press("j");
  await sleep(600);
  out.afterMoving = focusLine();
  await typed(":o plugins/helix-bridge/test/fixtures/workspace/util.go");
  await enter();
  await sleep(800);
  out.afterSwitching = focusLine();
  await typed("x");
  await sleep(600);
  out.afterSelectingLine = focusLine();

  // The owner's binding: F opens the file picker in the buffer's directory.
  await esc();
  await typed("F");
  await sleep(1000);
  await page.screenshot({ path: `${shots}/real-owner-F.png` });
  await esc();
  await sleep(300);

  // Bridge bindings from keys-bb.example.toml.
  await typed(" bi");
  await sleep(800);
  await page.screenshot({ path: `${shots}/real-bb-status.png` });
  await esc();
  await typed("gg3jx");
  await typed(" bs");
  await sleep(2500);
  out.composerAfterSend = await page.evaluate(() => [...document.querySelectorAll('[data-promptbox-layout] [contenteditable="true"]')].map((e) => e.innerText).join("|"));
  out.receipt = await page.evaluate(() => document.body.innerText.includes("From Helix"));
  await page.screenshot({ path: `${shots}/real-bb-send.png` });

  // :bb-comment through its prompt.
  await page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
  await esc();
  await typed("gg4jx");
  await typed(" bc");
  await sleep(600);
  await page.screenshot({ path: `${shots}/real-bb-comment-prompt.png` });
  await typed("probe comment from the real fork");
  await enter();
  await sleep(2000);
  await page.screenshot({ path: `${shots}/real-bb-comment-added.png` });

  // HUD numbers on the real fork.
  await esc();
  await typed(":o plugins/helix-bridge/spike/run.mjs");
  await enter();
  await sleep(800);
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press("j");
    await sleep(60);
  }
  await sleep(500);
  out.hudAfterJ = await hud();
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press("PageDown");
    await sleep(250);
  }
  await sleep(500);
  out.hudAfterPageDown = await hud();
  await page.screenshot({ path: `${shots}/real-hud.png` });
  await typed("gg");
} finally {
  await browser.close();
}
console.log(JSON.stringify(out, null, 1));
