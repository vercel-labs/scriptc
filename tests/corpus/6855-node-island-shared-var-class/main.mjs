// @requires-libnode
// A class that is the value of a `var` (`var Shape = class { … }; export
// { Shape }`, the form bundlers write for an exported class) in a module
// both sides import is one class (scope-B NI-6), like a declared one. The
// island module loads BEFORE the modules that hold the classes ran
// (early.mjs is imported first): it reads no value that does not exist yet,
// and once they ran, instances made on either side answer instanceof on
// both and the island constructs the classes.
import { area, caught, check, make, raise, sameClass } from "./early.mjs";
import { Shape, makeShape } from "./shapes.mjs";
import { KitError, codeOf, isKitError } from "kit";

console.log("main:", new Shape(3).area(), makeShape(2).area());
console.log("island, later:", area(4));
console.log("class identity:", sameClass(Shape, KitError));

const native = new KitError("made natively", 7);
console.log("island sees native instance:", check(native));
const fromIsland = make(9);
console.log(
  "native sees island instance:",
  fromIsland instanceof KitError,
  isKitError(fromIsland),
  codeOf(fromIsland),
);
console.log("native reads:", fromIsland.name, fromIsland.message, fromIsland.code);
console.log("native throws, island catches:", caught(3));
try {
  raise(5);
} catch (e) {
  console.log(
    "island throws, native catches:",
    e instanceof KitError,
    isKitError(e),
    codeOf(e),
    e instanceof Error,
  );
}
