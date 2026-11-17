#!/usr/bin/env node
// Live check helper: when a file in <dir> changes, ask spike/hold.mjs for a
// burst of screenshots and log the focused file a moment later.
//   node spike/on-change.mjs <dir> <ctl> <shotPrefix> <pid>
import { execFileSync } from "node:child_process";
import { watch, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, ctl, prefix, pid] = process.argv.slice(2);
let n = 0;
let last = 0;
watch(dir, (event, file) => {
  if (!file || file.startsWith(".") || Date.now() - last < 800) return;
  last = Date.now();
  const k = (n += 1);
  const at = new Date().toISOString();
  writeFileSync(join(ctl, `w${Date.now()}.cmd`), JSON.stringify({ type: "shots", path: `${prefix}-${k}-${file.replace(/\W/gu, "_")}.png`, every: 90, count: 10 }));
  setTimeout(() => {
    const state = execFileSync("bb", ["hx", "state", "--instance", pid], { encoding: "utf8" });
    console.log(JSON.stringify({ k, at, file, focused: /focused: (.*)/u.exec(state)?.[1] }));
  }, 1500);
});
console.log("watching", dir);
