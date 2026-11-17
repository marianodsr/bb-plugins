// Helix Bridge backend entry.
import { readFile } from "node:fs/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const WTERM_WASM = new URL("./node_modules/@wterm/ghostty/wasm/ghostty-vt.wasm", import.meta.url);

export default async function plugin(bb: BbPluginApi) {
  // The wterm renderer's Ghostty core is served separately from app.js.
  bb.http.route("GET", "/wterm-ghostty.wasm", async () => {
    const bytes = await readFile(WTERM_WASM);
    return new Response(bytes, { headers: { "content-type": "application/wasm", "cache-control": "no-cache" } });
  });
}
