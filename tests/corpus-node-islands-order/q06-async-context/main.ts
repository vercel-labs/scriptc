// @requires-libnode
// X { Y { T 0 { J } I { J } K { J } M { J } R { J } } }
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

island("Y { T 0 { J } I { J } K { J } M { J } R { J } }");
