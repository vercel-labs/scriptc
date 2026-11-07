// @requires-libnode
// A Worker the program starts from a module that runs in a Node island:
// its entry is a module of the program, so the island tree ships the entry
// and what it imports as real sources, and the worker thread evaluates its
// own copy (Node gives every thread its own module instances). The program's
// copy of state.ts and the worker's copy count separately.
import { bump, count } from "./state.ts";
import { roundTrip, socketTag } from "./launcher.ts";

console.log("socket:", socketTag());
console.log("main:", bump(), bump(), count);
console.log("worker:", await roundTrip(21));
console.log("main after:", count);
