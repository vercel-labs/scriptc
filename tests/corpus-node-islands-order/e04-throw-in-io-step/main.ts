// @requires-libnode
// @order: race
// X { G R { L i-io E } } B 30 L h-sync T 10 { L h-t10 }
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

island("G R { L i-io E }");
busy(30);
log("h-sync");
setTimeout(() => log("h-t10"), 10);
