// @requires-libnode
// I { L hI } X { I { L iI } M { L iM } K { L iK } } M { L hM } K { L hK } L sync
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

setImmediate(() => log("hI"));
island("I { L iI } M { L iM } K { L iK }");
queueMicrotask(() => log("hM"));
process.nextTick(() => log("hK"));
log("sync");
