"use strict";
// Values every caller gets (they never change), and fresh ones.
exports.shared = Object.freeze({ name: "shared", list: Object.freeze([1, 2, 3]) });
exports.add = (x) => x + 1;
exports.make = (i) => ({ i, tag: "t" + i });
exports.Point = class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  toString() {
    return `(${this.x},${this.y})`;
  }
};
