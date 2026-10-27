// A JavaScript package whose object literals start a property as
// `undefined` or `null` and later store records, numbers and arrays in it,
// as the diff package's path list does (`{ oldPos: -1, lastComponent:
// undefined }`). Node runs the later writes; each property holds them.
import { describe, session } from "edit-paths";

console.log(describe());
console.log(session());
