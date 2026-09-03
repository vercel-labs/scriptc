// @exit: 1
// An explicit ESM package does not expose a strip-only default-interface
// placeholder, including when a second module re-exports that default.
import DefaultShape from "./reexport.ts";

type LocalShape = DefaultShape;
console.log("never runs");
