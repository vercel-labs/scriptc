// `module.exports = { ... }` replaces the exports object: requirers get the
// new object, with the table's keys in source order and later members after.
const lib = require("./lib");
lib.extra = 1;
console.log(Object.keys(lib).join(","), lib.extra, lib.later);
console.log(require("./lib") === lib, require("./lib").extra);
console.log(lib);
