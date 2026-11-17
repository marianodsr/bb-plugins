#!/usr/bin/env node
// Send one command to spike/hold.mjs and print its answer.
//   node spike/say.mjs <ctl> '{"type":"type","text":":o main.go"}' [timeoutMs]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [ctl, json, timeout = "30000"] = process.argv.slice(2);
const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
writeFileSync(join(ctl, `${id}.cmd`), json);
const until = Date.now() + Number(timeout);
while (Date.now() < until) {
  const out = join(ctl, `${id}.out`);
  if (existsSync(out)) {
    console.log(readFileSync(out, "utf8"));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 25));
}
console.error("no answer");
process.exit(1);
