// @requires-libnode
// X { R { L i-io K { L i-tick } P { L i-p } M { L i-m } I { L i-imm } } } B 40 L h-sync
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

island("R { L i-io K { L i-tick } P { L i-p } M { L i-m } I { L i-imm } }");
busy(40);
log("h-sync");
