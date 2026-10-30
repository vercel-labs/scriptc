// @requires-libnode
// M { L hm1 } X { M { L im1 } } M { L hm2 } X { M { L im2 } } L sync
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

queueMicrotask(() => log("hm1"));
island("M { L im1 }");
queueMicrotask(() => log("hm2"));
island("M { L im2 }");
log("sync");
