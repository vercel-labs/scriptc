// A module's own exports object, used inside the module: identity
// comparisons (the UMD self-test), typeof and truthiness, and member calls.
const lib = require("./lib.js");
(function () {
  var root = this;
  console.log("wrapper", root === module.exports, root === exports, typeof root);
}).call(this);
function check() {
  return [exports === module.exports, typeof exports, typeof module.exports, !exports].join(" ");
}
console.log(check(), module.exports ? "truthy" : "falsy");
console.log(lib.contentType("json"), lib.describe());
exports.answer = function () {
  return 42;
};
function ask() {
  return module.exports.answer() + exports.answer();
}
console.log(exports.answer(), ask());
