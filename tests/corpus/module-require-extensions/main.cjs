/* require.extensions is node:module's Module._extensions: one null-prototype
 * table with Node's three handlers. A compiled program loads no module at
 * run time, so the handlers are function values that refuse when called;
 * keys, JSON, prototype and frozenness answer as Node's do; Module._extensions
 * itself is not represented. */
const extensions = require.extensions;

console.log("keys", JSON.stringify(Object.keys(extensions)));
console.log(
  "types",
  typeof extensions[".js"],
  extensions[".js"].name === "",
  extensions[".js"].length,
  typeof extensions[".json"],
  typeof extensions[".node"],
);
console.log("json", JSON.stringify(extensions));
console.log("proto", Object.getPrototypeOf(extensions) === null);
console.log("frozen", Object.isFrozen(extensions));
