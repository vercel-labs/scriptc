// A module cycle whose members read const-enum members in their top-level
// initializers: every module still evaluates once, in Node's order, and the
// folded member values are available before the cycle completes.
import { total } from "./limits.ts";
console.log("main", total());
