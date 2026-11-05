// @requires-libnode
// K { L hk1 K { L hk3 } } X { K { L ik1 M { L im1 } } } K { L hk2 } M { L hm1 }
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

process.nextTick(() => {
  log("hk1");
  process.nextTick(() => log("hk3"));
});
island("K { L ik1 M { L im1 } }");
process.nextTick(() => log("hk2"));
queueMicrotask(() => log("hm1"));
