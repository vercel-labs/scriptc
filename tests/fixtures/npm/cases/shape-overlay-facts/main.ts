// The shape overlay's facts: results that include undefined, literals that
// hold comment-like text, a var declared in a branch no call takes, and
// a var declared in two such branches.
import { banner, hoisted, lookup, lookupOrReturn, shared } from "shape-facts";

console.log(lookup("b"));
console.log(lookup("z"));
console.log(lookupOrReturn("a"));
console.log(lookupOrReturn("y"));
console.log(banner(7));
console.log(hoisted("note:"));
console.log(shared("level:"));
