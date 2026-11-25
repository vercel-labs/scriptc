"use strict";
// One error object every caller gets (it never changes), and fresh ones.
const shared = new TypeError("shared");
exports.failShared = () => {
  throw shared;
};
exports.fail = (i) => {
  throw new RangeError("bad " + i);
};
exports.rethrow = (error) => {
  throw error;
};
// Chunks of one pooled buffer, as a stream hands them to its listener.
const pool = Buffer.alloc(4096);
exports.feed = (count, listener) => {
  for (let i = 0; i < count; i++) listener(pool.subarray(i * 16, i * 16 + 16));
  return count;
};
exports.first = (bytes) => bytes[0];
exports.echo = (value) => value;
const kept = Buffer.from("kept");
exports.kept = () => kept;
exports.tagged = (key) => ({ [key]: 1 });
const symbol = Symbol("island");
exports.symbol = () => symbol;
