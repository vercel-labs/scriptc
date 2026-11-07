import { spawn } from "node:child_process";

// @types/node declares `stdio` as a 5-tuple; Node's array has one entry per
// configured stdio slot (3 here). The member has no lowering, and its
// length must not fold to the declared arity.
const child = spawn("echo", ["hi"]);
console.log(child.stdio.length);

// A program's own tuple still folds its arity.
const pair: [string, number] = ["a", 1];
const holder = { pair };
console.log(pair.length, holder.pair.length);
