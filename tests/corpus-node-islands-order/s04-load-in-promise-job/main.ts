// @requires-libnode
// Switch: Node loads in an async function's continuation while more promise
// jobs, ticks and timers are pending.
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

async function main(): Promise<void> {
  log("h-start");
  await null;
  log("h-after-await");
  queueMicrotask(() => log("h-m-before"));
  island("P { L i-p } M { L i-m } K { L i-k } T 0 { L i-t0 }");
  queueMicrotask(() => log("h-m-after"));
  await null;
  log("h-after-await2");
  process.nextTick(() => log("h-k"));
  await new Promise<void>((resolve) => setTimeout(resolve, 2));
  log("h-after-timer");
}
void Promise.resolve().then(() => log("h-p"));
setTimeout(() => log("h-t0"), 0);
void main();
