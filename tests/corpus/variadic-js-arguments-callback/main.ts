import { show } from "./util.js";

// Stored where a fixed callback type is expected and handed to an array
// method: JavaScript passes the element, its index and the array, so the
// stored function's `arguments` holds all three, named parameters included.
const one: (x: number) => number = show;
console.log([4, 5].map(one).join(","));
