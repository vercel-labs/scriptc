// util.types.isArgumentsObject over a compiled function's `arguments`,
// which the name itself or a constant holding it answers true, and no other
// value is an arguments object.
import * as util from "node:util";
import * as direct from "node:util/types";

function directName() {
  return util.types.isArgumentsObject(arguments);
}
function heldConstant() {
  const list = arguments;
  return util.types.isArgumentsObject(list);
}
function afterUse() {
  const first = arguments[0];
  return [first, util.types.isArgumentsObject(arguments)];
}
function directModule() {
  return direct.isArgumentsObject(arguments);
}
console.log("direct", directName(1, 2));
console.log("direct module", directModule("y"));
console.log("held", heldConstant());
console.log("after use", afterUse("x").join(","));
console.log("array", util.types.isArgumentsObject([1, 2]));
console.log("object", util.types.isArgumentsObject({ 0: 1, length: 1 }));
console.log("null", util.types.isArgumentsObject(null));
console.log("no argument", util.types.isArgumentsObject());
