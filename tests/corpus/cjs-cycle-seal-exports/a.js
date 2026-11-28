'use strict';
// A zod-style seal pass: define a lazy getter export, require a partner
// mid-cycle, then walk the module's own exports and materialize every
// accessor that answers a value.
exports.first = 1;
let second;
Object.defineProperty(exports, "second", {
  enumerable: true,
  configurable: true,
  get() {
    return second;
  },
});
const b = require("./b.js");
second = 2;
(function () {
  const keys = Object.getOwnPropertyNames(exports);
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(exports, key);
    if (!desc || !desc.get || !desc.configurable) continue;
    let value;
    try {
      value = desc.get();
    } catch (e) {
      continue;
    }
    if (value === undefined) continue;
    Object.defineProperty(exports, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
})();
exports.sealed = function () {
  return Object.getOwnPropertyDescriptor(exports, "second").get === undefined;
};
