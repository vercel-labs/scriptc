// @requires-libnode
// @exit: 1
// Typed code that holds an island promise as Promise<number>: one island
// code handles is not reported, one nobody handles ends the program.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s: string): void => console.log(s);
process.on("exit", (code) => console.log("exit", code));
const handled: Promise<number> = lib.selfHandled(5, "by the island", log);
const kept: Promise<number>[] = [handled];
setTimeout(() => {
  console.log("at 30 ms", kept.length);
  const unhandled: Promise<number> = lib.failing(5, "nobody handles this");
  kept.push(unhandled);
}, 30);
setTimeout(() => console.log("never printed"), 300);
