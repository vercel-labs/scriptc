// @requires-libnode
// A package whose exports are defined at run time compiles natively, but a
// program may not be able to bind what it reads from it. `umdkit` assigns its
// whole export from inside a wrapper function, to a module object it finds at
// run time, and hangs its functions on that export: nothing in its own
// modules refuses, so the refusal is at the program's read of `kit.greet`,
// and it is the package's. It runs in a Node island, named with the export
// and the read that moved it. A build used to answer this only when the
// package also had a pre-scan marker, and only after the whole build had
// failed. `builtkit` builds its whole export in a function at the top of its
// module: that compiles, and it stays native.
//
// `metrics` exports members whose bindings no longer hold the exported value
// when the program reads them (`counter` is reassigned after it is exported,
// `version` is written by the module and by its re-exporter). The native
// build has no binding to read either from, so those reads are the package's
// refusal too, and the island gives the values Node gives.
import built from "builtkit";
import { counter, version } from "metrics";
import kit from "umdkit";

console.log(built.greet("ada"), built.twice(21));
console.log(kit.greet("bob"), kit.twice(4), kit.version);
const { twice } = kit;
console.log(twice(8), typeof kit);
console.log(counter, version);
