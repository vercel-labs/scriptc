// Re-exporting a required ES module as a value publishes the module's
// namespace object, not an empty CommonJS exports object: Node's require()
// of an ES module answers that namespace, so a holder of the re-export sees
// the same object, its export names and values.
const index = require("./index.cjs");
const esm = require("./esm.mjs");

console.log("keys:", Object.keys(index.ESM).join(","));
console.log("identity:", index.ESM === esm);
console.log("values:", index.ESM.name, index.ESM.double(21));
console.log("tag:", Object.prototype.toString.call(index.ESM));
console.log("prototype:", Object.getPrototypeOf(index.ESM) === null);
console.log("extensible:", Object.isExtensible(index.ESM));
