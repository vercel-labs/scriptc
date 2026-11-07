// The accessor-exporting package of cjs-exports-accessor, required by two
// packages. Node runs the getter for each `require()` and hands each a
// table of its own (the loader reads the export five times for the first
// and once more for the second, so `assembled` is 5 for one and 6 for the
// other): each requiring module keeps the value its own `require()` got.
import { assembled as painterAssembled, paint } from "painter";
import { assembled as markerAssembled, mark } from "marker";

console.log(paint("red", "stop"), mark("go"));
console.log(painterAssembled(), markerAssembled());
