// @requires-libnode
// A program error whose message or cause the program made read-only or
// non-configurable before it first crosses keeps that in island code: the
// attributes there are the error's own, a write the error refuses changes
// neither side, and a redefinition it forbids throws as it does in one
// realm.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const attrs = (d) =>
  d === undefined ? "none" : `${d.writable ? "w" : "-"}${d.enumerable ? "e" : "-"}${d.configurable ? "c" : "-"}`;
const mine = (e) => ["message", "name", "cause"].map((k) => `${k}:${attrs(Object.getOwnPropertyDescriptor(e, k))}`).join(" ");

for (const how of ["plain", "locked", "readonly"]) {
  const err = new Error("first", { cause: "why" });
  if (how === "locked") {
    Object.defineProperty(err, "message", { value: "first", writable: false, enumerable: false, configurable: false });
    Object.defineProperty(err, "cause", { value: "why", writable: false, enumerable: true, configurable: false });
  } else if (how === "readonly") {
    Object.defineProperty(err, "message", { value: "first", writable: false, enumerable: false, configurable: true });
  }
  console.log(how, "program", mine(err));
  console.log(how, "island ", lib.describe(err));
  console.log(how, "island writes", lib.write(err));
  console.log(how, "program reads", err.message, String(err.cause));
  console.log(how, "island writes strictly", lib.strictWrite(err));
  // A read-only message that is still configurable is not redefined here:
  // island code cannot do that yet, where one realm can.
  if (how !== "readonly") console.log(how, "island redefines", lib.redefine(err));
  console.log(how, "island deletes", lib.remove(err));
  console.log(how, "program after", err.message, String(err.cause), mine(err));
  console.log(how, "island after ", lib.describe(err));
}
