// @requires-libnode
// Switch: Node loads inside an immediate while later immediates of the same check
// phase, and timers, are pending.
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

setImmediate(() => {
  log("h-i1");
  island("I { L i-imm } T 0 { L i-t0 } K { L i-k }");
  setImmediate(() => log("h-i1-imm"));
  process.nextTick(() => log("h-i1-k"));
});
setImmediate(() => log("h-i2"));
setImmediate(() => log("h-i3"));
setTimeout(() => log("h-t0"), 0);
