// @requires-libnode
// X { R { T 0 { L i-t0 } } } B 40 T 0 { L h-t0 } L h-sync
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

island("R { T 0 { L i-t0 } }");
busy(40);
setTimeout(() => log("h-t0"), 0);
log("h-sync");
