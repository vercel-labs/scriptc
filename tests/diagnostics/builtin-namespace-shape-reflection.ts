// A builtin module namespace whose runtime shape the type system does not
// fix: a parameter holds whichever shape the caller passed (an ES module
// namespace object or the CommonJS exports object), and a call the compiler
// does not trace may answer either. Reflection over them cannot report one
// shape's answer for both, so it is refused.
import * as fs from "node:fs";
import type * as NodeFs from "node:fs";

function keysOf(ns: typeof NodeFs): string[] {
  return Object.keys(ns);
}
function hasRead(ns: typeof NodeFs): boolean {
  return "readFileSync" in ns;
}
function ownRead(ns: typeof NodeFs): boolean {
  return ns.hasOwnProperty("readFileSync");
}
function describe(ns: { ns: typeof NodeFs }): string {
  return typeof ns.ns;
}
function load(): typeof NodeFs {
  return require("fs");
}
console.log(
  keysOf(fs).length,
  hasRead(fs),
  ownRead(fs),
  describe({ ns: fs }),
  Object.keys(load()).length,
);
