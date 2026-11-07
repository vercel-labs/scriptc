// The exports object a requirer holds carries the prototype its table
// literal asked for, and no `__proto__` key of its own.
const lib = require("./lib.cjs");
console.log(Object.getPrototypeOf(lib) === null);
console.log(Object.keys(lib).join(","));
console.log(Object.prototype.hasOwnProperty.call(lib, "__proto__"));
console.log(lib.answer);

const prototyped = require("./prototyped.cjs");
console.log(Object.getPrototypeOf(prototyped).greeting);
console.log(Object.keys(prototyped).join(","));
console.log(prototyped.answer);
