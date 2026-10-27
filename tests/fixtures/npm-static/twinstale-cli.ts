// twinstale's @types twin describes an older release than the installed
// package: the program typechecks against the twin, but not against the
// JavaScript's inferred surface (under Node the import is undefined).
import { stale } from "twinstale";

console.log(stale("ready"));
