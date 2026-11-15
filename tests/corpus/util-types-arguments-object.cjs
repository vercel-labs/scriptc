// util.types.isArgumentsObject in a CommonJS JavaScript source: true for
// `arguments` (also through a constant that holds it), false for arrays and
// the require() module objects.
const util = require("node:util");
const { types } = require("node:util");
const direct = require("node:util/types");

function plain() {
  const held = arguments;
  return [
    util.types.isArgumentsObject(arguments),
    types.isArgumentsObject(held),
    direct.isArgumentsObject(arguments),
    types.isSet(arguments),
  ].join(" ");
}
console.log("direct", plain(1, 2));

console.log("others", types.isArgumentsObject([]), types.isArgumentsObject({ length: 2 }));
console.log("module", types.isArgumentsObject(require("node:path")));
