// @requires-libnode
// Errors thrown across the island boundary and caught by the program, many
// times over: a program error thrown from a callback an island function
// called, and an error island code threw. Each catch reads the error, and
// V8 collects garbage several times while the loop runs.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const n = 30000;
let native = 0;
let island = 0;
let length = 0;
for (let i = 0; i < n; i++) {
  try {
    lib.run(() => {
      throw new Error("native " + i);
    });
  } catch (e) {
    if (e instanceof Error && e.message === "native " + i) native++;
  }
  try {
    lib.fail(i);
  } catch (e) {
    if (e instanceof RangeError && e.name === "RangeError") island++;
    length += e.message.length;
  }
}
console.log("caught", native, island, length);
