// @requires-libnode
// T 0 { L h1 } X { T 0 { L i1 } } T 0 { L h2 } X { T 0 { L i2 } }
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

setTimeout(() => log("h1"), 0);
island("T 0 { L i1 }");
setTimeout(() => log("h2"), 0);
island("T 0 { L i2 }");
