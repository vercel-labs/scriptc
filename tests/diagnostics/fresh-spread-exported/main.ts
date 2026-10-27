// An exported const array spread once in its own module: in Node, writes
// through the importer's binding show in the array the spread filled.
import { listed, results, shared } from "./items.js";
shared[0].message = "changed";
listed[0].noisy = false;
console.log(results.map((r) => `${r.message}:${r.noisy}`).join(" "));
