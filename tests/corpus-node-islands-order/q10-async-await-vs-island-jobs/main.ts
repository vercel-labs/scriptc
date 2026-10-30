// @requires-libnode
// async f: await, ha1, await, ha2, await, ha3 || X { P { L ip1 P { L ip2 P { L ip3 } } } }
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

async function steps(): Promise<void> {
  await null;
  log("ha1");
  await null;
  log("ha2");
  await Promise.resolve();
  log("ha3");
}
void steps();
island("P { L ip1 P { L ip2 P { L ip3 } } }");
log("sync");
