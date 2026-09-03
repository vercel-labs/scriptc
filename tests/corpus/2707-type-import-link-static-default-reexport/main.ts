// @exit: 1
// A default interface is visible to a direct default import under Node's
// strip-only loader, but not when a second module re-exports that default.
import DefaultShape from "./reexport.ts";

type LocalShape = DefaultShape;
console.log("never runs");
