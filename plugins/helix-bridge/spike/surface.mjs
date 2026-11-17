#!/usr/bin/env node
// Drive the shipped editor surface in a private headless Chrome: key-to-paint
// from the HUD (setting `hud` on), and the key matrix as the surface sends it
// to the PTY, checking that no Escape, Ctrl, Alt or function key makes bb act.
//
//   node spike/surface.mjs --thread <threadId> [--width 1440] [--out spike/out/surface.json]
import { writeFileSync } from "node:fs";
import { launch, SERVER, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const thread = opt("thread", "thr_fh7kmixkaj");
const width = Number(opt("width", "1440"));
const out = opt("out", "spike/out/surface.json");

const ALT = 1, CTRL = 2, META = 4, SHIFT = 8;
const macOption = { x: "≈", ".": "≥", ";": "…", o: "ø", i: "Dead", n: "Dead", e: "Dead", u: "Dead", c: "ç", s: "ß", k: "˚", j: "∆", p: "π", d: "∂", b: "∫", f: "ƒ" };
const codeOf = (c) => (/^[a-z]$/.test(c) ? `Key${c.toUpperCase()}` : { ".": "Period", ";": "Semicolon", ",": "Comma", "/": "Slash", "[": "BracketLeft", "`": "Backquote", " ": "Space" }[c]);
const kc = (c) => (/^[a-z]$/.test(c) ? c.toUpperCase().charCodeAt(0) : { ".": 190, ";": 186, ",": 188, "/": 191, "[": 219, "`": 192, " ": 32 }[c]);
const named = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, PageDown: 34, Home: 36 };

function spec(label) {
  const parts = label.split("+");
  const base = parts.pop();
  let mods = 0;
  for (const m of parts) mods |= { Alt: ALT, Ctrl: CTRL, Cmd: META, Shift: SHIFT }[m];
  if (named[base] || /^F\d+$/.test(base)) return { key: base, code: base, keyCode: named[base] ?? 111 + Number(base.slice(1)), mods };
  const ch = base === "Space" ? " " : base;
  let key = mods & SHIFT && /^[a-z]$/.test(ch) ? ch.toUpperCase() : ch;
  if (mods & ALT && !(mods & (CTRL | META)) && macOption[ch]) key = macOption[ch];
  const text = key !== "Dead" && !(mods & (CTRL | META)) ? key : undefined;
  return { key, code: codeOf(ch), keyCode: kc(ch), mods, text };
}

const MATRIX = [
  "Escape", "Tab", "Shift+Tab", "F1", "F5", "F12", "Ctrl+c", "Ctrl+d", "Ctrl+w", "Ctrl+o", "Ctrl+s", "Ctrl+k", "Ctrl+[", "Ctrl+Space",
  "Alt+x", "Alt+.", "Alt+;", "Alt+o", "Alt+i", "Alt+n", "Alt+e", "Alt+u", "Alt+c", "Alt+Shift+c", "Ctrl+Alt+x", "Alt+ArrowUp",
  "Cmd+k", "Cmd+j",
];

const { browser, page } = await launch({ width, height: 900, theme: "dark" });
const cdp = await page.createCDPSession();
const result = { width };
try {
  await page.goto(`${SERVER}/plugins/helix-bridge/editor/${thread}`, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForSelector("[data-helix-hud]", { timeout: 30000 });
  await sleep(2500);
  const hud = () => page.evaluate(() => {
    const cells = [...document.querySelectorAll("[data-helix-hud] > span")].map((s) => s.textContent);
    const o = {};
    for (let i = 0; i + 1 < cells.length; i += 2) o[cells[i]] = cells[i + 1];
    return o;
  });
  const effects = () => page.evaluate(() => ({
    path: location.pathname,
    focusInEditor: Boolean(document.activeElement?.closest?.("[data-helix-terminal]")),
    dialogs: document.querySelectorAll('[role="dialog"], [role="menu"], [cmdk-root]').length,
  }));
  result.start = { hud: await hud(), effects: await effects() };

  // Typing: j 60 times, then 20 full redraws.
  for (let i = 0; i < 60; i += 1) { await page.keyboard.press("j"); await sleep(60); }
  await sleep(500);
  result.afterJ = await hud();
  for (let i = 0; i < 20; i += 1) { await page.keyboard.press("PageDown"); await sleep(250); }
  await sleep(500);
  result.afterPageDown = await hud();

  // Key matrix (Escape back to normal mode between keys; Helix is the target).
  const dispatch = async (s) => {
    const modKeys = [[ALT, "Alt", "AltLeft", 18], [CTRL, "Control", "ControlLeft", 17], [META, "Meta", "MetaLeft", 91], [SHIFT, "Shift", "ShiftLeft", 16]].filter(([b]) => s.mods & b);
    let held = 0;
    for (const [b, key, code, keyCode] of modKeys) { held |= b; await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers: held, location: 1 }); }
    await cdp.send("Input.dispatchKeyEvent", { type: s.text ? "keyDown" : "rawKeyDown", key: s.key, code: s.code, windowsVirtualKeyCode: s.keyCode, modifiers: s.mods, ...(s.text ? { text: s.text } : {}) });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: s.key, code: s.code, windowsVirtualKeyCode: s.keyCode, modifiers: s.mods });
    for (const [b, key, code, keyCode] of modKeys.reverse()) { held &= ~b; await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers: held, location: 1 }); }
  };
  result.matrix = [];
  for (const label of MATRIX) {
    const before = await effects();
    await dispatch(spec(label));
    await sleep(650); // the HUD refreshes every 500 ms
    const after = await effects();
    const h = await hud();
    const bb = [after.path !== before.path && `navigated ${after.path}`, before.focusInEditor && !after.focusInEditor && "focus left the editor", after.dialogs > before.dialogs && "dialog or menu opened"].filter(Boolean).join(", ");
    result.matrix.push({ key: label, received: h["Last key"], sent: h.Sent, bb: bb || null });
    if (bb) {
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      if (after.path !== before.path) { await page.goBack().catch(() => {}); await sleep(2500); }
      await page.evaluate(() => document.querySelector("[data-helix-terminal] textarea")?.focus());
      await sleep(300);
    }
  }
  // Leave Helix in normal mode.
  await page.keyboard.press("Escape");
  await page.screenshot({ path: out.replace(/\.json$/u, ".png") });
} finally {
  writeFileSync(out, JSON.stringify(result, null, 1));
  await browser.close();
}
console.log(JSON.stringify({ start: result.start, afterJ: result.afterJ, afterPageDown: result.afterPageDown }, null, 1));
for (const r of result.matrix ?? []) console.log(`${r.key.padEnd(16)} received ${String(r.received).padEnd(22)} sent ${String(r.sent).padEnd(18)} ${r.bb ?? ""}`);
