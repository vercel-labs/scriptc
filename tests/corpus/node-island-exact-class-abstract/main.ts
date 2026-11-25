// @requires-libnode
// A class nothing constructs has no instances, so the exact-class crossing gives it no branch:
// its abstract members cannot be method values, and a hierarchy that contains it still crosses.
import { requireModule } from "@scriptc/node";
import { Base, Circle, Leaf, Plain, Shape } from "./classes.ts";

const island = requireModule("./island.mjs");
const base: Base = new Base();
console.log("base:", island.probe(base));
const leaf: Base = new Leaf();
console.log("leaf:", island.probe(leaf));
const plain: Base = new Plain();
console.log("plain:", island.probe(plain));
// A value typed as the abstract class: every instance it can hold has a concrete class the
// crossing proves, and the abstract class's own table answers its concrete methods.
const shape: Shape = new Circle();
console.log("shape:", island.probeStatic(shape));
