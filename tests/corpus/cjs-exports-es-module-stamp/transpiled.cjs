// tsc's CommonJS output for an ES module: the non-enumerable stamp first,
// then the default export and the named export.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = greet;
exports.named = 7;

function greet() {
  return "hi";
}
