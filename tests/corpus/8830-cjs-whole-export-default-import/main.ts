// A default import of a CommonJS module binds module.exports itself (Node's
// ESM-CJS interop). When the module's retained `module.exports = <value>` is
// a single value — an identifier, a function expression, or a re-export of
// one — that VALUE is the binding: members read as properties of the export,
// not as entries of an export table.
import instance from "./inst.cjs";
import twice from "./fn.cjs";
import wrapped from "./wrap.cjs";

console.log(instance.seed, instance.read());
console.log(twice(21), typeof twice);
console.log(wrapped.seed, wrapped.read());
console.log(Object.keys(instance).sort().join(","));
