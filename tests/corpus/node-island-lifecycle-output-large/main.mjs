// @requires-libnode
// Writes larger than a pipe buffer from both sides alternate without
// interleaving or loss, write callbacks run, and everything written before
// the end is delivered.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

for (let i = 0; i < 2; i++) {
  process.stdout.write("N".repeat(100000) + "\n");
  lib.big("I", 100000);
  console.log("n".repeat(20000));
}
process.stdout.write("native with callback\n", () => console.log("native write callback"));
lib.bigCb("i", 100000, () => console.log("island write callback (native function)"));
console.log("main end");
