// `x instanceof tls.Server` where x is a primitive literal: the operand has
// no handle tag to test, so the answer is false and the literal is a no-op.
import * as tls from "node:tls";

console.log("null", null instanceof tls.Server);
console.log("undefined", undefined instanceof tls.Server);
console.log("number", 5 instanceof tls.Server);
console.log("string", "x" instanceof tls.Server);
console.log("true", true instanceof tls.Server);
console.log("object", ({}) instanceof tls.Server);

const values = [null, undefined, 5, "x", true, {}, []];
for (const value of values) console.log("loop", value instanceof tls.Server);
