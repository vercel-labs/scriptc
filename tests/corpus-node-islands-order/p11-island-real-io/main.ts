// @requires-libnode
// @order: race
// X { R { L i-io M { L i-io-micro } } } R { L h-io } T 0 { L h-t0 }
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

island("R { L i-io M { L i-io-micro } }");
readFile(import.meta.filename, "utf8", () => {
  log("h-io");
});
setTimeout(() => log("h-t0"), 0);
