// @requires-libnode
// X { T 10 { L i-t10 } } T 20 { L h-t20 } B 30 L h-sync
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

island("T 10 { L i-t10 }");
setTimeout(() => log("h-t20"), 20);
busy(30);
log("h-sync");
