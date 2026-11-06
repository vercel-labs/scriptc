// A function imported under a different name keeps the name of the binding
// that created it: V8's SetFunctionName runs once, at the definition.
import builder from "./names.js";

console.log(builder.name);
const alias = builder;
console.log(alias.name);
