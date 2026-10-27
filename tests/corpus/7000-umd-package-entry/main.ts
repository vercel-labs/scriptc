// A package whose main entry is TypeScript's UMD emit: each module's body is
// a factory the wrapper calls with the module's own require and exports, so
// its requires and export assignments sit inside a function. Node runs the
// CommonJS branch, and the named imports read the factory's exports.
import { Shape, area, describe, label, unitCount } from "umd-shapes";

console.log(label, unitCount);
console.log(area({ kind: Shape.Square, size: 3 }), area({ kind: Shape.Circle, size: 1 }).toFixed(4));
console.log(describe({ kind: Shape.Square, size: 2 }));
console.log(Shape.Circle, Shape[Shape.Square]);
