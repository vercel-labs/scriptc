"use strict";
let kept;
exports.makeBuffer = () => (kept = Buffer.from("hello"));
exports.kept = () => kept;
exports.read = (b) => `${b.constructor.name} ${Buffer.isBuffer(b)} [${Array.from(b).join(",")}]`;
exports.fill = (b, v) => {
  b.fill(v);
  return b.length;
};
exports.same = (a, b) => a === b;
exports.floats = () => new Float64Array([1.5, -0, NaN]);
exports.sum = (arr) => arr.reduce((a, b) => a + b, 0);
