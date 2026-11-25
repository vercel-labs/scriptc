// @requires-libnode
// A natively compiled CommonJS package binds the function an island
// package exports with `var` and calls it in its module-level code and
// again inside its exported function: both calls cross into the island.
import { scale } from "recipe-scale";

console.log(scale("cup", 2), scale("spoon", 3), scale("pinch", 4), scale("dash", 1));
