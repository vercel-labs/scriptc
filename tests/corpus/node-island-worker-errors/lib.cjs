"use strict";
// One error object every caller gets (it never changes), and fresh ones.
const shared = new TypeError("shared");
exports.failShared = () => {
  throw shared;
};
exports.fail = (i) => {
  const error = new RangeError("bad " + i);
  error.code = "E_BAD";
  error.status = i % 7;
  throw error;
};
exports.status = (error) => (error instanceof RangeError ? error.status : -1);
exports.rethrow = (error) => {
  throw error;
};
