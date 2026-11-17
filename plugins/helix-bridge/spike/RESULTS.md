# Editor surface spike: results

Run on 2026-11-16, bb 0.49.0, plugin SDK 0.6.132, headless Chrome
(chrome-headless-shell, software WebGL, 60 Hz), 1440x900 viewport, stock
Helix 25.07 with a throwaway config directory and no language server, on
`net/http/server.go` (4,102 lines). Keys are CDP key events shaped like a Mac
browser's (Option chords carry the composed character, or `Dead`).

Tools: `spike/keyecho.mjs` (logs every byte a key produces), `spike/run.mjs`
(creates a bb terminal, shows it, measures), `app/spike/SpikePage.tsx` (the
plugin page that attaches to `/ws/terminals/<id>` and renders it), and
`app/terminal/` (stream and renderer adapter, kept for the real surface).

```
node spike/run.mjs --renderer stock|ghostty-web|wterm-dom|wterm-webgl --mode hx|keys|keys-kitty
```

## Renderers

| | bb stock (xterm.js) | ghostty-web 0.4.0 | @wterm/dom + @wterm/ghostty 0.6.0, DOM | same, WebGL |
|---|---|---|---|---|
| Licence | (bb's) | MIT | Apache-2.0 | Apache-2.0 |
| Grid in this test | 155x69 (12 px), maximised panel | 138x54 (13 px), plugin page | 140x47 (13 px) | 140x47 |
| Key `j` to paint, p50 / p95 | 15.3 / 19.2 ms | 16.7 / 25.7 | 21.3 / 27.2 | 16.7 / 24.9 |
| PageDown (full redraw) to paint, p50 / p95 | 14.5 / 20.1 ms | 24.1 / 28.0 | 21.4 / 26.9 | 14.0 / 21.4 |
| Output to paint on PageDown, p50 / p95 | 9.5 / 12.6 ms | 18.9 / 19.6 | 17.0 / 19.6 | 8.8 / 15.4 |
| Replayed full redraw (~15-25 KB): paint work in the frame, p50 / p95 | 1.4 / 4.9 ms | 13.4 / 17.5 | 12.2 / 16.0 | 5.3 / 10.9 |
| WebAssembly memory | none | 12.9 MB | 4.9 MB | 4.9 MB |
| JS heap (page) | 44.7 MB (thread page) | 30.9 MB | 31.6 MB | 32.3 MB |
| DOM nodes (page) | 1,392 | 579 | 2,357 | 2,323 |

Key-to-paint splits the same way everywhere: key to socket send under 1 ms,
socket send to first output 5-6 ms (server, daemon, PTY, Helix), the rest is
the renderer. Every renderer lands within one or two 60 Hz frames. Software
WebGL understates what the WebGL renderers do on a real GPU.

## Terminal features Helix uses

| | stock | ghostty-web | wterm |
|---|---|---|---|
| True colour (`COLORTERM=truecolor`, 24-bit ramp) | yes | yes | yes |
| Mouse (SGR 1006: click, wheel, drag) | yes | **no reports at all** | yes |
| Bracketed paste | yes (`\r` line ends) | **no** (raw text) | yes (`\n` line ends) |
| Focus reports (1004) | yes | **no** | yes |
| OSC 52 clipboard write | **no** | **no** | yes (callback; host applies it) |
| Kitty keyboard protocol (`CSI ? u` reply) | no | **no** (encoder exists, not negotiated) | yes (`CSI ? 1 u`) |
| Resize to the PTY | yes | yes | yes |

## Key matrix (legacy encoding unless noted)

All three pass plain keys, Escape, Enter, Tab, Backspace, arrows,
Home/End/PageUp/PageDown, Insert/Delete, F1-F12 and Ctrl+letters with the
standard xterm bytes. Differences:

| Keys | stock | ghostty-web | wterm |
|---|---|---|---|
| Option+letter (Helix `A-x`, `A-.`, `A-;`, `A-o`, ...) | composed char (`≈`): **wrong** | **nothing sent** | `ESC ≈`: **wrong** (kitty: `CSI 8776;3u`, also wrong) |
| Option dead keys (`A-e`, `A-i`, `A-n`, `A-u`, `` A-` ``) | nothing | nothing | nothing |
| Shift+Tab | `CSI Z` | `^I`: **wrong** | `CSI Z` |
| Shift+F5 | `CSI 15;2~` | `CSI 15~`: modifier lost | `CSI 15;2~` |
| Ctrl+i, Ctrl+[ | `^I`, `ESC` | `CSI 105;5u`, `CSI 91;5u` without negotiation | `^I`, `ESC` |
| Ctrl+Tab, Ctrl+Enter | `^I`, `^M` | `CSI 27;5;9~`, `CSI 27;5;13~` | `^I`, `^M` |
| Ctrl+`` ` `` | nothing | `CSI 96;5u` | nothing |
| Ctrl+V | nothing (all three; headless Chrome treats it as paste) | | |
| Cmd chords | bb acts on Cmd+J, K, `,`, Shift+O; focus leaves the terminal on every Cmd key | **sent to the app as the bare letter** (Cmd+J sends `j`) | bb acts on Cmd+J, K, `,`, Shift+O; others go nowhere |
| Kitty mode (wterm only) | | | Escape `CSI 27u`, Ctrl+c `CSI 99;5u`, Shift+Enter `CSI 13;2u`, Ctrl+Alt+x `CSI 120;7u`: correct |

No Escape, Ctrl, Alt or function key triggered any bb action in any renderer.

## Room

At 1440x900 with the sidebar open, a maximised panel tab gets 1104x828 px and
a plugin page 1120x824 px. With the owner's Ghostty font (FiraCode Nerd Font
Mono, 17 px) that is about 108x39 cells; hiding the sidebar adds about 30
columns. SDK 0.6.132 has no `experimental_primarySurface` and no terminal
attach API; the plugin attaches to `/ws/terminals/<id>` itself.

## Recommendation

`@wterm/ghostty` with `@wterm/dom`, `renderer: "webgl"` (it falls back to DOM
without WebGL2). It is the only candidate that does everything Helix needs
(mouse, bracketed paste, focus, OSC 52, Kitty keyboard), its core is a third
of ghostty-web's memory, and with WebGL its full-redraw cost is close to bb's
own terminal. ghostty-web 0.4.0 renders correctly but its input layer is not
ready (no mouse, paste or focus reporting, wrong Shift+Tab, Cmd leaks into
the app). bb's stock terminal is fast but sends Option as composed characters
and has no Kitty protocol or OSC 52.

The surface needs its own thin key layer whatever the renderer: Option as Alt
(from `KeyboardEvent.code`, so dead keys work too; legacy `ESC x`, Kitty
`CSI 120;3u`), and a capture-phase guard so bb's Cmd shortcuts do not fire
while the editor has focus, except a small documented escape set.

Not verified here: the bb desktop app's own menu accelerators (CDP events
bypass them), a real keyboard and non-US layouts, real GPU numbers.

## After the decision

The coordinator chose `@wterm/ghostty` + `@wterm/dom` with WebGL. ghostty-web
was removed from the plugin's dependencies; `spike/SpikePage.tsx` and
`spike/renderer-candidates.ts` are kept for the record and need
`npm install ghostty-web@0.4.0` and a navPanel registration to run again.
`spike/surface.mjs` measures the shipped surface through its HUD (setting
`hud`). Headless Chrome, 1440x900, stock hx 25.07 on the same Go file:
key-to-paint 15.2 ms p50, 20.3 ms p95 (60 keys); 15.3 / 22.3 over 80 keys
with 20 full redraws; paint work per frame 0.6 ms p50, 6.5 ms p95; WebGL.

## Step 3: where the p95 goes (2026-11-17)

Question: is the 48-54 ms key-to-paint p95 on the real fork (against ~20 ms
with stock Helix) our position updates? Answer: no.

**Interleaved A/B on one session and file** (`spike/ab.mjs`: rotating order,
6 rounds of 40 cursor moves at 50 ms per mode, `bb hx perf-mode <mode>
--instance <ours>`; HUD samples split into key-to-first-output and the rest).
`off`: no event subscriptions; `quiet`: events folded in the host, no signal,
so no server or UI update; `normal`: everything. `hxb` with the owner's
config, `plugins/helix-bridge/server.ts`, 1440x900 headless, load average
4-8:

| | off | quiet | normal |
|---|---|---|---|
| key to paint, p50 / p95 | 15.0 / 18.1 ms | 15.2 / 18.4 | 15.5 / 18.4 |
| key to first output, p50 / p95 | 6.8 / 10.1 ms | 6.6 / 9.9 | 7.3 / 10.3 |

The same run while the shared Rust build held the load average at ~21: 16 /
51.0, 16 / 50.3, 16 / 48.8 ms, the tail entirely in key-to-first-output, and
it moved between rounds, not between modes.

**Stock against fork, same surface, same throwaway config and file**
(`spike/ab-binary.mjs`, blocks interleaved; load 5-10):

| | hx 25.07 | hxb 25.07.1 |
|---|---|---|
| 4,100-line Go file, key to paint p50 / p95 | 14.4 / 17.8 ms | 32.8 / 36.0 |
| same, key to first output p50 | 6.2 ms | 26.3 |
| 410-line TypeScript file, key to paint p50 / p95 | 13.9 / 18.0 ms | 13.7 / 17.0 |

**Without a browser** (`spike/rtt.mjs`: bb terminals attached over
`/ws/terminals/<id>`, key to first output): `stty raw; cat` 3 ms p50; stock
hx 1.9 ms on the Go file; hxb 26 ms, with or without the bridge connected
(an `XDG_CACHE_HOME` the plugin does not watch), with the owner's config or a
throwaway one, file on the command line or opened later. On large Rust (7,220
lines) and TypeScript (24,774 lines) files both stay under 5 ms p95.

What makes it slow: Go highlighting at width. The same hxb instance answers in
1.8 ms at 53 columns and 26 ms at 100 or 140 (rows do not matter). With the Go
`highlights.scm` and `locals.scm` emptied in a copy of the fork's runtime it
is 1.9 ms; with injections emptied it is still 26 ms; reverting upstream
#15997 (the newest Go highlights change) does not help. The queries and the
highlighter are upstream's (the fork's base is newer than 25.07); none of it
is bridge code.
