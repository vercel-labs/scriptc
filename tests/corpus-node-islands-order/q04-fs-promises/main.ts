// @requires-libnode
// @order: race
// X { A { L i-a P { L i-ap } } } B 40 L h-sync T 0 { L h-t0 }
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

island("A { L i-a P { L i-ap } }");
busy(40);
log("h-sync");
setTimeout(() => log("h-t0"), 0);
