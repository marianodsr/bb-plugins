#!/usr/bin/env node
// Send one control command to a running mock bridge and print its answer.
//   node test/mock-bridge/ctl.mjs <controlSocket> '{"cmd":"send","kind":"send","note":"look"}'
import { createConnection } from "node:net";

export function control(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, nl)));
      }
    });
    socket.on("error", reject);
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const [socketPath, json] = process.argv.slice(2);
  console.log(JSON.stringify(await control(socketPath, JSON.parse(json)), null, 2));
}
