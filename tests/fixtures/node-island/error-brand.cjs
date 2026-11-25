"use strict";
let reads = 0;
exports.error = (detached) => {
  const error = new TypeError("island");
  Object.defineProperty(error, "name", {
    get() {
      reads++;
      return "TypeError";
    },
  });
  if (detached) Object.setPrototypeOf(error, null);
  return error;
};
exports.prototypeOnly = () => Object.create(Error.prototype);
exports.lookalike = () => ({ name: "Error", message: "island", "%error": true });
exports.reads = () => reads;
const kept = new TypeError("kept");
exports.kept = () => kept;
exports.fail = () => { throw kept; };
exports.same = (value) => value === kept;
exports.callWith = (f, value) => f(value);
exports.reject = () => Promise.reject(kept);
exports.detach = (value) => { Object.setPrototypeOf(value, null); };
