"use strict";
exports.answer = 42;
exports.greet = function greet(name) {
  return "hello " + name;
};
exports.config = { mode: "strict", depth: 3 };
