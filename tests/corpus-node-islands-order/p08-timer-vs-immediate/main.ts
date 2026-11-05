// @requires-libnode
// @order: race
// T 1 { L h-t1 } X { T 0 { L i-t0 } I { L i-imm } } I { L h-imm }
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

setTimeout(() => log("h-t1"), 1);
island("T 0 { L i-t0 } I { L i-imm }");
setImmediate(() => log("h-imm"));
