#!/usr/bin/env node
// Terminal renderer spike driver. Creates a bb terminal, shows it with one
// renderer in a private headless Chrome, and measures it.
//
//   node spike/run.mjs --renderer stock|ghostty-web|wterm-dom|wterm-webgl --mode hx|keys|keys-kitty
//
// stock: bb's own terminal tab (xterm.js) in the thread's side panel, maximised.
// Others: this plugin's spike page, full-bleed.
// hx: stock Helix on a 4,100-line Go file with a throwaway config directory;
//     key-to-paint over 60 `j` presses, full redraw over 25 PageDowns, memory.
// keys: spike/keyecho.mjs; the key matrix plus paste, mouse, focus, resize, OSC 52.
// Writes spike/out/<renderer>-<mode>.json and prints a summary.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, SERVER, sleep } from "./browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const renderer = opt("renderer", "ghostty-web");
const mode = opt("mode", "hx");
const THREAD = opt("thread", "thr_fh7kmixkaj");
const PROJECT = opt("project", "proj_v2ia75srgp");
const storage = `/Users/marianodsr/.bb/thread-storage/${THREAD}/spike`;
const title = `spike ${renderer} ${mode} ${Date.now() % 100000}`;
const log = join(storage, `keys-${renderer}-${mode}.jsonl`);

const command =
  mode === "hx"
    ? `env XDG_CONFIG_HOME=${storage}/xdg-config XDG_CACHE_HOME=${storage}/xdg-cache hx ${storage}/server.go`
    : `env KEYECHO_LOG=${log} KEYECHO_KITTY=${mode === "keys-kitty" ? 1 : 0} node ${here}/keyecho.mjs`;
// ---------------------------------------------------------------------------

async function openSpike(page) {
  await page.goto(`${SERVER}/plugins/helix-bridge/spike/${terminalId}/${renderer}`, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForFunction(() => window.__hxSpike?.ready, { timeout: 20000 });
  await page.evaluate(() => {
    const spike = window.__hxSpike;
    // The page's own paint callback feeds the shared probe.
    const paints = spike.paints;
    paints.push = (...v) => { window.__drv.paints.push(...v); return Array.prototype.push.apply(paints, v); };
    window.__drvSize = () => spike.renderer.size();
    window.__drvWasm = () => spike.renderer.wasmBytes();
    window.__drvFocus = () => spike.renderer.focus();
  });
}

async function openStock(page) {
  await page.goto(`${SERVER}/projects/${PROJECT}/threads/${THREAD}`, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(1500);
  await page.evaluate(() => [...document.querySelectorAll('button[aria-label^="Show right panel"]')].find((b) => b.getBoundingClientRect().width > 0)?.click());
  await sleep(800);
  const clicked = await page.evaluate((title) => {
    const pill = [...document.querySelectorAll("#thread-detail-secondary-panel button")].find((b) => b.textContent.trim() === title);
    pill?.click();
    return Boolean(pill);
  }, title);
  if (!clicked) throw new Error(`no panel tab "${title}"`);
  await sleep(800);
  await page.evaluate(() => [...document.querySelectorAll('button[aria-label="Maximize pane"]')].find((b) => b.getBoundingClientRect().width > 0)?.click());
  await sleep(1200);
  const found = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".xterm")].find((x) => x.getBoundingClientRect().width > 0);
    const isTerm = (c) => c && typeof c === "object" && c.buffer && typeof c.onRender === "function" && c.options;
    for (let n = el; n; n = n.parentElement) {
      const key = Object.keys(n).find((k) => k.startsWith("__reactFiber"));
      if (!key) continue;
      for (let f = n[key], i = 0; f && i < 40; i++, f = f.return)
        for (let h = f.memoizedState, j = 0; h && j < 60; j++, h = h.next)
          for (const c of [h.memoizedState, h.memoizedState?.current])
            if (isTerm(c)) {
              window.__xterm = c;
              c.onRender(() => window.__drv.paints.push(performance.now()));
              window.__drvSize = () => ({ cols: c.cols, rows: c.rows });
              window.__drvWasm = () => null;
              window.__drvFocus = () => c.focus();
              return { macOptionIsMeta: c.options.macOptionIsMeta };
            }
    }
    return null;
  });
  if (!found) throw new Error("stock xterm not found");
  result.xtermOptions = found;
}

async function terminalBox(page) {
  const sel = renderer === "stock" ? ".xterm" : "[data-spike-host]";
  return page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((x) => x.getBoundingClientRect().width > 0);
    return el.getBoundingClientRect().toJSON();
  }, sel);
}

const pct = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
};

async function reset(page) {
  await page.evaluate(() => { const d = window.__drv; d.keys.length = d.wsOut.length = d.wsIn.length = d.paints.length = 0; });
}

function analyse(trace, { last = false } = {}) {
  const rows = [];
  for (let i = 0; i < trace.keys.length; i += 1) {
    const k = trace.keys[i];
    const next = trace.keys[i + 1] ?? Infinity;
    const outs = trace.wsOut.filter((o) => o.t > k && o.t < next);
    const sent = trace.wsIn.find((o) => o.t >= k && o.t < next);
    if (outs.length === 0) { rows.push({ missing: true }); continue; }
    const firstOut = outs[0].t;
    const paints = trace.paints.filter((p) => p >= firstOut && p < next);
    if (paints.length === 0) { rows.push({ missingPaint: true }); continue; }
    const paint = last ? paints[paints.length - 1] : paints[0];
    rows.push({
      keyToPaint: paint - k,
      keyToSend: sent ? sent.t - k : null,
      sendToOutput: sent ? firstOut - sent.t : null,
      outputToPaint: paint - firstOut,
      outputChars: outs.reduce((sum, o) => sum + o.n, 0),
    });
  }
  const ok = rows.filter((r) => r.keyToPaint !== undefined);
  const col = (name) => ok.map((r) => r[name]).filter((v) => v !== null);
  return {
    samples: ok.length,
    missing: rows.length - ok.length,
    keyToPaint: { p50: pct(col("keyToPaint"), 50), p95: pct(col("keyToPaint"), 95), max: pct(col("keyToPaint"), 100) },
    keyToSend: { p50: pct(col("keyToSend"), 50), p95: pct(col("keyToSend"), 95) },
    sendToOutput: { p50: pct(col("sendToOutput"), 50), p95: pct(col("sendToOutput"), 95) },
    outputToPaint: { p50: pct(col("outputToPaint"), 50), p95: pct(col("outputToPaint"), 95), max: pct(col("outputToPaint"), 100) },
    outputCharsP50: pct(col("outputChars"), 50),
  };
}

async function memory(page) {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  await cdp.send("Performance.enable");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (name) => metrics.find((m) => m.name === name)?.value ?? null;
  return {
    jsHeapUsedMB: Math.round((get("JSHeapUsedSize") / 1048576) * 10) / 10,
    domNodes: get("Nodes"),
    wasmMB: await page.evaluate(() => { const b = window.__drvWasm?.(); return b == null ? null : Math.round((b / 1048576) * 10) / 10; }),
  };
}

// Renderer-only cost of a full-screen redraw: feed the captured PageDown
// output back in, 3 passes. write = synchronous parse (xterm: until its write
// callback); frame = time spent in the paint frame before a callback queued
// after the renderer's, i.e. the renderer's paint work in that frame.
async function replay(page) {
  return page.evaluate(async () => {
    const chunks = window.__drv.big.map((b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
    if (chunks.length === 0) return null;
    const frame = () => new Promise((resolve) => requestAnimationFrame((ts) => resolve(performance.now() - ts)));
    const writes = [], frames = [];
    for (let pass = 0; pass < 3; pass += 1) {
      for (const bytes of chunks) {
        const t0 = performance.now();
        if (window.__xterm) await new Promise((resolve) => window.__xterm.write(bytes, resolve));
        else window.__hxSpike.renderer.write(bytes);
        writes.push(performance.now() - t0);
        frames.push(await frame());
      }
    }
    const q = (v, p) => { const s = [...v].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10; };
    return { chunks: chunks.length, avgBytes: Math.round(chunks.reduce((a, c) => a + c.length, 0) / chunks.length), write: { p50: q(writes, 0.5), p95: q(writes, 0.95) }, frame: { p50: q(frames, 0.5), p95: q(frames, 0.95) } };
  });
}

async function press(key, times, gap) {
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press(key);
    await sleep(gap);
  }
}

async function measureHelix(page) {
  result.memoryAfterOpen = await memory(page);
  await reset(page);
  await press("j", 60, 70);
  await sleep(300);
  const traceJ = await page.evaluate(() => window.__drv);
  result.traceCounts = { keys: traceJ.keys.length, wsOut: traceJ.wsOut.length, wsIn: traceJ.wsIn.length, paints: traceJ.paints.length, spikeOutputs: await page.evaluate(() => window.__hxSpike?.outputs.length ?? null) };
  console.log("trace", JSON.stringify(result.traceCounts));
  result.keyJ = analyse(traceJ);
  await reset(page);
  await press("PageDown", 25, 300);
  await sleep(500);
  result.pageDown = analyse(await page.evaluate(() => window.__drv));
  result.replay = await replay(page);
  result.memoryAfterPaging = await memory(page);
  console.log(JSON.stringify({ size: result.size, keyJ: result.keyJ, pageDown: result.pageDown, replay: result.replay, memory: result.memoryAfterPaging }, null, 1));
}

// ---------------------------------------------------------------------------
// Key matrix. Modifier bits as CDP: Alt 1, Ctrl 2, Meta 4, Shift 8. Alt
// chords carry the character macOS produces for Option on a US layout, or
// "Dead" for its dead keys, because that is what a Mac browser receives.

const ALT = 1, CTRL = 2, META = 4, SHIFT = 8;
const named = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Insert: 45, Home: 36, End: 35, PageUp: 33, PageDown: 34, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
const macOption = { a: "å", b: "∫", c: "ç", d: "∂", e: "Dead", f: "ƒ", h: "˙", i: "Dead", j: "∆", k: "˚", l: "¬", n: "Dead", o: "ø", p: "π", r: "®", s: "ß", u: "Dead", w: "∑", x: "≈", ".": "≥", ";": "…", ",": "≤", "`": "Dead", "-": "–" };
const macOptionShift = { c: "Ç", u: "¨", "\\": "»", ";": "Ú" };
const codeOf = (ch) => (/^[a-z]$/.test(ch) ? `Key${ch.toUpperCase()}` : /^[0-9]$/.test(ch) ? `Digit${ch}` : { ".": "Period", ";": "Semicolon", ",": "Comma", "`": "Backquote", "-": "Minus", "\\": "Backslash", "[": "BracketLeft", "]": "BracketRight", "/": "Slash", " ": "Space", "%": "Digit5" }[ch]);
const keyCodeOf = (ch) => (/^[a-z]$/.test(ch) ? ch.toUpperCase().charCodeAt(0) : /^[0-9]$/.test(ch) ? ch.charCodeAt(0) : { ".": 190, ";": 186, ",": 188, "`": 192, "-": 189, "\\": 220, "[": 219, "]": 221, "/": 191, " ": 32, "%": 53 }[ch]);

function spec(label) {
  const parts = label.split("+");
  const base = parts.pop();
  let mods = 0;
  for (const m of parts) mods |= { Alt: ALT, Ctrl: CTRL, Cmd: META, Shift: SHIFT }[m];
  if (named[base] || /^F\d+$/.test(base)) {
    const keyCode = named[base] ?? 111 + Number(base.slice(1));
    const text = base === "Enter" && !(mods & (CTRL | META | ALT)) ? "\r" : undefined;
    return { label, key: base, code: base, keyCode, mods, text };
  }
  const ch = base === "Space" ? " " : base.toLowerCase();
  let key = ch;
  if (mods & SHIFT && /^[a-z]$/.test(ch)) key = ch.toUpperCase();
  if (mods & ALT && !(mods & (CTRL | META))) key = (mods & SHIFT ? macOptionShift[ch] : macOption[ch]) ?? key;
  const printable = key !== "Dead" && !(mods & (CTRL | META));
  return { label, key, code: codeOf(ch), keyCode: keyCodeOf(ch), mods, text: printable ? key : undefined };
}

const MATRIX = [
  "a", "Shift+A", "Space", "Enter", "Tab", "Shift+Tab", "Backspace", "Delete", "Insert", "Escape",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
  "Shift+ArrowUp", "Ctrl+ArrowLeft", "Alt+ArrowUp", "Alt+ArrowLeft", "Ctrl+Shift+ArrowRight",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`), "Shift+F5", "Ctrl+F2",
  ..."abcdefghijklnoprstuvwxyz".split("").map((c) => `Ctrl+${c}`), "Ctrl+Space", "Ctrl+[", "Ctrl+]", "Ctrl+\\", "Ctrl+/", "Ctrl+6",
  "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+`", "Ctrl+Enter", "Shift+Enter", "Alt+Enter", "Ctrl+Backspace", "Alt+Backspace",
  ...Object.keys(macOption).map((c) => `Alt+${c}`), "Alt+Shift+c", "Alt+Shift+u", "Alt+Shift+\\", "Ctrl+Alt+x",
  "Cmd+j", "Cmd+t", "Cmd+k", "Cmd+\\", "Cmd+,", "Cmd+o", "Cmd+Shift+o", "Cmd+p", "Cmd+1", "Cmd+w", "Cmd+f", "Cmd+l", "Cmd+n", "Cmd+b", "Cmd+Enter", "Cmd+[", "Cmd+c", "Cmd+v",
];

async function dispatch(s) {
  const modKeys = [[ALT, "Alt", "AltLeft", 18], [CTRL, "Control", "ControlLeft", 17], [META, "Meta", "MetaLeft", 91], [SHIFT, "Shift", "ShiftLeft", 16]].filter(([bit]) => s.mods & bit);
  let held = 0;
  for (const [bit, key, code, keyCode] of modKeys) {
    held |= bit;
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers: held });
  }
  await cdp.send("Input.dispatchKeyEvent", { type: s.text ? "keyDown" : "rawKeyDown", key: s.key, code: s.code, windowsVirtualKeyCode: s.keyCode, modifiers: s.mods, ...(s.text ? { text: s.text, unmodifiedText: s.text } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: s.key, code: s.code, windowsVirtualKeyCode: s.keyCode, modifiers: s.mods });
  for (const [bit, key, code, keyCode] of modKeys.reverse()) {
    held &= ~bit;
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers: held });
  }
}

function readLog() {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function sideEffects(page) {
  return page.evaluate(() => ({
    path: location.pathname,
    focusInTerminal: Boolean(document.activeElement?.closest?.(".xterm, [data-spike-host]")),
    panelOpen: Boolean(document.querySelector("#thread-detail-secondary-panel")),
    dialogs: document.querySelectorAll('[role="dialog"], [role="menu"], [cmdk-root]').length,
  }));
}

async function restore(page, before) {
  const now = await sideEffects(page);
  if (now.dialogs > before.dialogs) { await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await sleep(200); }
  if (now.path !== before.path) { await page.goBack().catch(() => {}); await sleep(1500); }
  await page.evaluate(() => window.__drvFocus?.());
  await sleep(100);
}

async function settle(seen, ms = 350) {
  await sleep(ms);
  return readLog().filter((e) => e.kind === "input").slice(seen);
}

async function keyMatrix(page, box) {
  const start = readLog();
  result.start = start.find((e) => e.kind === "start");
  const kitty = start.filter((e) => e.kind === "input");
  result.kittyQueryReply = kitty.map((e) => e.decoded);
  let seen = kitty.length;
  // Paste: a real paste event on the focused element, as Cmd+V produces.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "hello\nworld");
    document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  let got = await settle(seen);
  seen += got.length;
  result.paste = got.map((g) => g.decoded).join(" | ") || null;

  // Mouse: click, wheel, drag inside the terminal.
  const cx = box.x + 120, cy = box.y + 90;
  await page.mouse.click(cx, cy);
  got = await settle(seen); seen += got.length; result.mouseClick = got.map((g) => g.decoded).join(" | ") || null;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel({ deltaY: 120 });
  got = await settle(seen); seen += got.length; result.mouseWheel = got.map((g) => g.decoded).join(" | ") || null;
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 80, cy + 20, { steps: 4 }); await page.mouse.up();
  got = await settle(seen); seen += got.length; result.mouseDrag = got.map((g) => g.decoded).join(" | ") || null;

  // Focus reporting.
  await page.evaluate(() => document.activeElement?.blur());
  got = await settle(seen); seen += got.length; result.focusOut = got.map((g) => g.decoded).join(" | ") || null;
  await page.evaluate(() => window.__drvFocus?.());
  got = await settle(seen); seen += got.length; result.focusIn = got.map((g) => g.decoded).join(" | ") || null;

  // OSC 52: ask keyecho to write the clipboard.
  await page.evaluate(() => { window.__drv.clipboard.length = 0; });
  await dispatch(spec("%"));
  await sleep(500);
  result.osc52 = await page.evaluate(() => [...window.__drv.clipboard, ...(window.__hxSpike?.clipboard ?? [])]);


  const rows = [];
  for (const label of MATRIX) {
    const s = spec(label);
    const before = await sideEffects(page);
    await page.evaluate(() => { window.__drv.prevented.length = 0; });
    await dispatch(s);
    const got = await settle(seen);
    seen += got.length;
    const after = await sideEffects(page);
    const bb = [];
    if (after.path !== before.path) bb.push(`navigated ${after.path}`);
    if (!after.focusInTerminal) bb.push("focus left terminal");
    if (after.panelOpen !== before.panelOpen) bb.push(after.panelOpen ? "panel opened" : "panel closed");
    if (after.dialogs > before.dialogs) bb.push("dialog or menu opened");
    rows.push({ key: label, sent: s.key, bytes: got.map((g) => g.decoded).join(" | ") || null, bb: bb.join(", ") || null });
    if (bb.length) {
      await restore(page, before);
      seen += (await settle(seen, 200)).length; // focus-in reports from the refocus
    }
  }
  result.matrix = rows;

  // Resize: shrink the window.
  await page.setViewport({ width: 1100, height: 700 });
  await sleep(900);
  result.resize = readLog().filter((e) => e.kind === "resize").map((e) => `${e.cols}x${e.rows}`);
  console.log(JSON.stringify({ start: result.start, kitty: result.kittyQueryReply, paste: result.paste, mouse: [result.mouseClick, result.mouseWheel, result.mouseDrag], focus: [result.focusOut, result.focusIn], osc52: result.osc52, resize: result.resize }, null, 1));
  for (const r of rows) console.log(`${r.key.padEnd(24)} ${String(r.bytes).padEnd(36)} ${r.bb ?? ""}`);
}

// ---------------------------------------------------------------------------
// Main, last so every declaration above is initialised.
const created = JSON.parse(
  execFileSync("bb", ["terminal", "create", "--thread", THREAD, "--title", title, "--json", "--command", command], { encoding: "utf8" }),
);
var terminalId = created.id;
console.log(`terminal ${terminalId} (${title})`);

var { browser, page } = await launch({ width: 1440, height: 900, theme: "dark" });
var cdp = await page.createCDPSession();
var result = { renderer, mode, terminalId, viewport: "1440x900" };

// Instrumentation shared by every renderer: key time (capture phase, first
// listener on window), terminal socket traffic, clipboard writes.
await page.evaluateOnNewDocument(() => {
  const probe = (window.__drv = { keys: [], wsOut: [], wsIn: [], paints: [], clipboard: [], prevented: [] });
  window.addEventListener("keydown", (e) => probe.keys.push(performance.now()), true);
  window.addEventListener("keydown", (e) => { if (e.defaultPrevented) probe.prevented.push(e.key); }, false);
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      if (!String(url).includes("/ws/terminals/")) return;
      probe.big = [];
      this.addEventListener("message", (e) => {
        const text = String(e.data);
        probe.wsOut.push({ t: performance.now(), n: text.length });
        if (text.length > 6000 && probe.big.length < 40) {
          try { const m = JSON.parse(text); if (m.type === "output") probe.big.push(m.chunk.dataBase64); } catch {}
        }
      });
      const send = this.send.bind(this);
      this.send = (data) => {
        probe.wsIn.push({ t: performance.now(), n: String(data).length });
        return send(data);
      };
    }
  };
  const clip = navigator.clipboard;
  if (clip) {
    const write = clip.writeText?.bind(clip);
    clip.writeText = (text) => { probe.clipboard.push(text); return write ? write(text).catch(() => {}) : Promise.resolve(); };
  }
  const exec = document.execCommand.bind(document);
  document.execCommand = (cmd, ...rest) => { if (cmd === "copy") probe.clipboard.push(`execCommand(copy): ${String(window.getSelection())}`); return exec(cmd, ...rest); };
});

try {
  if (renderer === "stock") await openStock(page);
  else await openSpike(page);
  await sleep(mode === "hx" ? 2500 : 1200);
  const box = await terminalBox(page);
  result.box = box;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(400);
  result.size = await page.evaluate(() => window.__drvSize?.());
  if (mode === "hx") await measureHelix(page);
  else await keyMatrix(page, box);
} finally {
  mkdirSync(join(here, "out"), { recursive: true });
  writeFileSync(join(here, "out", `${renderer}-${mode}.json`), JSON.stringify(result, null, 1));
  await page.screenshot({ path: join(here, "out", `${renderer}-${mode}.png`) }).catch(() => {});
  await browser.close();
  try { execFileSync("bb", ["terminal", "close", terminalId], { stdio: "ignore" }); } catch {}
}

