// @requires-libnode
// @order: race
// Switch: work of every kind is pending in the program's queues when Node loads
// during the main body: timers (one an interval), an immediate, a tick, a
// microtask and a promise job (fs callbacks: s06).
import { callSync } from "@scriptc/node";
import { writeSync } from "node:fs";

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
setTimeout(() => log("h-t5"), 5);
setTimeout(() => log("h-t0"), 0);
const interval = setInterval(() => {
  log("h-iv");
  if (++fired === 3) clearInterval(interval);
}, 3);
setImmediate(() => log("h-imm"));
queueMicrotask(() => log("h-m"));
process.nextTick(() => log("h-k"));
void Promise.resolve().then(() => log("h-p"));
island("T 0 { L i-t0 } T 5 { L i-t5 } I { L i-imm } K { L i-k } M { L i-m } P { L i-p }");
setTimeout(() => log("h-t0b"), 0);
setImmediate(() => log("h-imm2"));
queueMicrotask(() => log("h-m2"));
process.nextTick(() => log("h-k2"));
log("sync");
