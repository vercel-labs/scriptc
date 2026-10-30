var even;
let calls = 0;
exports.name = "odd";
exports.isOdd = function (n) {
  calls++;
  return n === 0 ? false : even.isEven(n - 1);
};
exports.calls = function () {
  return calls;
};
even = (require("./even.cjs"));
console.log("odd: loaded");
