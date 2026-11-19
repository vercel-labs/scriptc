exports.keysOfA = function () {
  return Object.keys(a).join(",");
};
exports.same = function (other) {
  return other === a;
};
exports.tag = function () {
  a.fromB = true;
  return a.a2;
};
const a = require("./a");
