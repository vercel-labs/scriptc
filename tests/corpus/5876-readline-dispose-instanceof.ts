// rl[Symbol.dispose]() closes the interface as close() does, and a second
// call does nothing. instanceof tells node:readline's Interface from
// node:readline/promises' one.
import * as readline from "node:readline";
import * as readlinePromises from "node:readline/promises";
import { PassThrough } from "node:stream";

const rl = readline.createInterface({ input: new PassThrough() });
rl.on("close", () => console.log("close 1"));
rl[Symbol.dispose]();
console.log("disposed");
rl[Symbol.dispose]();
rl.close();
console.log("after second dispose");

const prl = readlinePromises.createInterface({ input: new PassThrough() });
prl.on("close", () => console.log("close 2"));
console.log(rl instanceof readline.Interface, rl instanceof readlinePromises.Interface);
console.log(prl instanceof readline.Interface, prl instanceof readlinePromises.Interface);
prl[Symbol.dispose]();

function make(): readline.Interface {
  return readline.createInterface({ input: new PassThrough() });
}
const made = make();
made.on("close", () => console.log("close 3"));
made[Symbol.dispose]();
console.log("done");
