"use strict";
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}
exports.typeError = () => {
  throw new TypeError("not a number: 'x'");
};
exports.rangeError = () => {
  [].length = -1;
};
exports.syntaxError = () => JSON.parse("{oops");
exports.coded = () => {
  const error = new Error("no such thing");
  error.code = "ENOTHING";
  throw error;
};
exports.custom = () => {
  throw new ValidationError("bad input");
};
exports.string = () => {
  throw "boom";
};
exports.object = () => {
  throw { reason: "nope", retry: false };
};
exports.notAFunction = 42;
exports.later = () => Promise.reject(new Error("never seen"));
exports.big = () => 10n;
exports.fine = () => "ok";
