// A typed module reads a live binding that untyped code updates in a loop.
import { reset, run, total } from "./counter.mjs";

console.log(run(100), total);
reset(2.5);
console.log(run(10), total);
