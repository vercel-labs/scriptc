var odd;
exports.name = "even";
exports.isEven = function (n) {
  return n === 0 ? true : odd.isOdd(n - 1);
};
exports.describe = function (n) {
  return n + " is " + (exports.isEven(n) ? "even" : "odd") + " (asked " + odd.name + ")";
};
odd = require("./odd.cjs");
console.log("even: loaded");
