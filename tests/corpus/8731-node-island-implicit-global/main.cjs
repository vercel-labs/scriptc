// @requires-libnode
// A sloppy-mode write to a name no declaration binds creates a property on
// the global object at run time (ECMAScript OrdinarySetWithOwnDescriptor).
// The native tier has no global object, so the checker refuses the write
// (SC1091) and the enclosing JavaScript module runs in a Node island under
// the default --node-islands=auto: the implicit global lives in Node, where
// the rest of the module reads it, exactly as when Node runs the source.
const legacy = require("./legacy.cjs");
console.log(legacy.read());
legacy.bump();
console.log(legacy.read());
console.log(legacy.kind(), legacy.missing());
