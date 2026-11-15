// Its only imports bind nothing at run time: tsc drops both declarations.
import {} from "./leaf-empty.js";
import { type LeafTag } from "./leaf-types.js";
console.log("leaf evaluated");
export const leaf: LeafTag = "leaf";
