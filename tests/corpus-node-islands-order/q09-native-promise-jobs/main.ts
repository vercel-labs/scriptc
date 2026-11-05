// @requires-libnode
// P { L hp1 } X { P { L ip1 P { L ip3 } } } P { L hp2 P { L hp3 } } L sync
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

Promise.resolve().then(() => log("hp1"));
island("P { L ip1 P { L ip3 } }");
Promise.resolve().then(() => {
  log("hp2");
  Promise.resolve().then(() => log("hp3"));
});
log("sync");
