'use strict';
// A lazy getter export answers undefined while the module still evaluates.
let value;
Object.defineProperty(exports, "lazy", {
  enumerable: true,
  configurable: true,
  get() {
    return value;
  },
});
const b = require("./b.js");
value = 7;
