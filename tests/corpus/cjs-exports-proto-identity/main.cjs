// Every read of the namespace sees the one prototype its table literal built,
// so identity holds across reads and a mutation through it persists.
const lib = require("./lib.cjs");
const proto = Object.getPrototypeOf(lib);
console.log(proto.tag);
proto.tag = "mutated";
const again = require("./lib.cjs");
console.log(Object.getPrototypeOf(again) === proto);
console.log(Object.getPrototypeOf(again).tag);
console.log(lib.answer, again.answer);
console.log(lib.evaluations());
const reader = require("./reader.cjs");
console.log(reader.proto === proto);
console.log(reader.proto.tag);
console.log(Object.keys(lib).join(","));
console.log(Object.prototype.hasOwnProperty.call(lib, "__proto__"));
