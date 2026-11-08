// A package whose export object is an accessor installed with
// Object.defineProperty(module, 'exports', { get }) (node_modules/palette),
// required by one other package: Node runs the getter when that package
// requires it, and the natively compiled module exports the getter's value.
import { assembled, names, paint } from "painter";

console.log(paint("red", "stop"), paint("bold", "loud"), paint("none", "as is"));
console.log(names().join(","), assembled());
