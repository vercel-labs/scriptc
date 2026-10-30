// @requires-libnode
// @order: race
// X { T 0 { D { L i-dns } } } T 2 { B 80 L h-sync }
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

island("T 0 { D { L i-dns } }");
setTimeout(() => {
  busy(80);
  log("h-sync");
}, 2);
