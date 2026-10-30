// @requires-libnode
// @order: race
// Switch: Node loads inside a timer callback while timers of the same and later
// deadlines, an immediate and an interval are pending.
import { callSync } from "@scriptc/node";
import { readFile, writeSync } from "node:fs";

function log(s: string): void {
  writeSync(1, `${s}\n`);
}

function busy(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function island(src: string): void {
  callSync("../island.cjs", "run", src);
}

let fired = 0;
const interval = setInterval(() => {
  log("h-iv");
  if (++fired === 2) clearInterval(interval);
}, 1);
setTimeout(() => {
  log("h-a");
  island("T 0 { L i-t0 } I { L i-imm } K { L i-k } M { L i-m }");
  queueMicrotask(() => log("h-a-m"));
  process.nextTick(() => log("h-a-k"));
  log("h-a-end");
}, 1);
setTimeout(() => log("h-b"), 1);
setTimeout(() => log("h-c"), 4);
setImmediate(() => log("h-imm"));
