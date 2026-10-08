// Function declarations of an import cycle are initialized before any
// module body runs: each member's top level calls functions of the other
// member while the cycle is still evaluating, including mutual recursion.
import { isEven, parity } from "./even.ts";
import { isOdd } from "./odd.ts";

console.log(isEven(10), isOdd(7), isEven(3));
console.log(parity(5), parity(8));
