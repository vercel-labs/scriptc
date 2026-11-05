// @requires-libnode
// @order: race
// X { R { L i-io } } B 30 L h-sync T 0 { L h-t0 }
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

island("R { L i-io }");
busy(30);
log("h-sync");
setTimeout(() => log("h-t0"), 0);
