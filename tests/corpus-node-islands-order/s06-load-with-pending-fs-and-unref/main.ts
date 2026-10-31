// @requires-libnode
// @order: race
// Switch: fs callbacks and an unref'd timer are pending when Node loads; the
// unref'd timer must not keep the program alive, the refreshed one must.
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

const unrefd = setTimeout(() => log("h-unref-never"), 50);
unrefd.unref();
const refreshed = setTimeout(() => log("h-refreshed"), 5);
readFile(import.meta.filename, "utf8", () => {
  log("h-io-1");
  readFile(import.meta.filename, "utf8", () => log("h-io-2"));
});
island("T 2 { L i-t2 }");
refreshed.refresh();
log(`has-ref ${String(unrefd.hasRef())} ${String(refreshed.hasRef())}`);
