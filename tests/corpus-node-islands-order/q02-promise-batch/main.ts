// @requires-libnode
// X { P { L ip1 P { L ip2 } } } M { L hm1 M { L hm2 } }
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

island("P { L ip1 P { L ip2 } }");
queueMicrotask(() => {
  log("hm1");
  queueMicrotask(() => log("hm2"));
});
