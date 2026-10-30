// Pre-module constructor functions and namespace functions: the forms shape
// inference compiles as classes and direct functions, and the forms it must
// keep (called without new, enumerated prototypes, read names). Output is the same either way.
import { ns } from "static-ns";

console.log(ns.run());
let total = 0;
for (let i = 0; i < 100; i++) total += new ns.Point(i, i).moved(1).norm();
console.log(Math.round(total));
