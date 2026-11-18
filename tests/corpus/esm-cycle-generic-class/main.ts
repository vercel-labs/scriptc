// A class declared in a module of an import cycle is in its temporal dead
// zone until its declaration runs, generic classes included: the top-level
// call below reaches CustomEvent first, throws Node's ReferenceError, and
// the same class constructs normally once its statement has run.
import { early, late } from "./events.ts";

console.log("main", early, late);
