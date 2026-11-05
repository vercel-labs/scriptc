"use strict";
const shared = { count: 0, items: [] };

class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  norm() {
    return Math.hypot(this.x, this.y);
  }
}

exports.shared = shared;
exports.Point = Point;
exports.getShared = () => shared;
exports.bump = () => ++shared.count;
exports.read = (o, k) => o[k];
exports.same = (a, b) => a === b;
exports.makeCounter = () => {
  let n = 0;
  return { inc: () => ++n, get value() { return n; } };
};
exports.add = (a, b) => a + b;
exports.numbers = () => [-0, NaN, Infinity, 2 ** 53 + 2, 10n ** 30n, -7n];
exports.isNegZero = (x) => Object.is(x, -0);
exports.strings = () => ["plain", "wörld ☃ 🌍", "lone \ud800 high", "\udc00 lone low"];
exports.codeUnits = (s) => Array.from(s, (c) => c.charCodeAt(0).toString(16)).join(" ");
exports.describe = (v) => `${typeof v} ${Object.prototype.toString.call(v)}`;
exports.keysOf = (o) => Object.keys(o).join(",");
