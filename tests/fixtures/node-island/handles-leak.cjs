"use strict";
exports.make = (i) => ({ i, payload: new Array(16).fill(i), tag: `object ${i}` });
exports.buffer = (i) => Buffer.alloc(64, i & 0xff);
exports.fail = (i) => {
  throw new Error(`failure ${i}`);
};
exports.later = async (i) => i;
