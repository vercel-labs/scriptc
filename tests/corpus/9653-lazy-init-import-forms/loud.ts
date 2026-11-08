import { id } from "./ids.ts";
import { SQUARES } from "./squares.ts";

// Prints while it loads, wherever it is loaded from, and draws there. The
// read of the table stands under a test the compiler cannot decide.
export const LOUD: number = id("loud");
console.log("loud loads and draws", LOUD);
export const SEEN: number = process.argv.length > 99 ? -1 : SQUARES.length;
