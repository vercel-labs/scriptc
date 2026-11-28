// @requires-libnode
// A class-typed value crossing into an island carries the class it has at run time, not the one
// its static type names: methods, `in` and fields of the class it actually has answer there.
import { requireModule } from "@scriptc/node";
import { Base, factory, Factory, Leaf, Mid } from "./classes.ts";

const island = requireModule("./island.mjs");
const asBase: Base = new Leaf();
const asMid: Base = new Mid();
const plain: Base = new Base();
console.log("leaf:", island.probe(asBase));
console.log("mid:", island.probe(asMid));
console.log("base:", island.probe(plain));
console.log("same:", island.kind(asBase), island.kind(asMid), island.kind(plain));
const made = new Factory().make()!;
const concrete = made as Leaf;
console.log("made:", island.probe(made), String(concrete.mid), String(concrete.leaf));
