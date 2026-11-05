// @requires-libnode
// @order: race
// X { T 0 { L i-a K { L i-tick } M { L i-micro } I { L i-imm } } } T 0 { L h-t0 M { L h-micro } }
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

island("T 0 { L i-a K { L i-tick } M { L i-micro } I { L i-imm } }");
setTimeout(() => {
  log("h-t0");
  queueMicrotask(() => log("h-micro"));
}, 0);
