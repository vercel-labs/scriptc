/// <reference path="./globals.d.ts" />
// A bare reference to a declared global resolves through the global object,
// as in Node: `document`, `counter`, and `flags` are declared only in a
// script-style declaration file, the program assigns its values to the
// global object before reading them, so every read (and `typeof`) answers
// what the assignment stored. `unused` is declared the same way but the
// program never writes it, so its read stays Node's ReferenceError.
import { before } from "./probe.ts";
import "./install.ts";
import { report } from "./report.ts";

console.log(before.join(","));
console.log(typeof document, typeof counter, typeof flags);
const el = document.getElementById("x");
console.log(el === null ? "null" : el.id);
console.log(counter + 1, counter * 2, counter / 4);
console.log(flags.length, flags[0], flags.join("|"));
console.log(document.getElementById("z") === null ? "absent" : "present");
console.log(typeof unused, typeof unused === "undefined");
try {
  console.log(unused);
} catch (err) {
  if (err instanceof Error) console.log(err.name + ": " + err.message);
}
report();
function shadow(document: Doc): string {
  return document.getElementById("s") === null ? "shadow-none" : "shadow-some";
}
console.log(shadow({ getElementById: () => null }));
console.log(typeof document === "object", document.getElementById("x")!.id);
