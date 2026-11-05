// @requires-libnode
// Deferred island packages (scope-B NI-7) that the program uses later:
// before the first real use, reads come from the interface snapshot; the
// first call starts Node, evaluates the deferred modules in import order
// and reconciles each stub with its real value, so values the program
// took before Node started are the same objects afterwards.
import { counted, format, getFormat, helpers, Shape, VERSION } from "lazy-pkg";
import { ANSWER, greet } from "esm-lazy";

console.log("before first use", VERSION, ANSWER, typeof greet, greet.name, greet.length);
const keepFormat = format;
const keepShape = Shape;
console.log("calls", format("a", 3), format(7, 2));
console.log("identity", getFormat() === format, keepFormat === format, getFormat() === keepFormat);
const s = new Shape(4);
console.log(s.describe(), s instanceof Shape, s instanceof keepShape, s.sides);
console.log(helpers.twice(21), helpers.sep);
console.log("counted", counted(), counted());
console.log(greet("world"), ANSWER);
