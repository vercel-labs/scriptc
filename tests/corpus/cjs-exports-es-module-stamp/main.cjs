// A transpiled ES module's CommonJS output carries a non-enumerable
// `__esModule` stamp, and tsc's dynamic interop decides whether a value is
// already an ES module translation by reading it. Re-exporting the module
// publishes the stamped exports object itself, so interop keeps the module
// instead of wrapping it as an unmarked CommonJS default.
const index = require("./index.cjs");
const transpiled = require("./transpiled.cjs");

function interop(mod) {
  return mod && mod.__esModule ? mod : { default: mod };
}

const marked = interop(index.MARKED);

console.log("kept:", marked === index.MARKED);
console.log("identity:", index.MARKED === transpiled);
console.log("keys:", Object.keys(index.MARKED).join(","));
console.log("names:", Object.getOwnPropertyNames(index.MARKED).join(","));
console.log("enumerable:", Object.prototype.propertyIsEnumerable.call(index.MARKED, "__esModule"));
console.log("value:", marked.default(), marked.named);
