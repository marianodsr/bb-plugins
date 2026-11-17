// Sends the queries Helix sends at start and logs what the terminal answers.
import { appendFileSync, writeFileSync } from "node:fs";
const log = process.argv[2];
writeFileSync(log, "");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (b) => appendFileSync(log, JSON.stringify([...b.toString("latin1")].map((c) => (c < " " ? `^${String.fromCharCode(c.charCodeAt(0) + 64)}` : c)).join("")) + "\n"));
setTimeout(() => {
  process.stdout.write("\x1b[?u");      // kitty flags query
  process.stdout.write("\x1b[?2026$p"); // synchronized output
  process.stdout.write("\x1b[c");       // primary device attributes
  process.stdout.write("probing\r\n");
}, 2500);
setTimeout(() => process.exit(0), 6000);
