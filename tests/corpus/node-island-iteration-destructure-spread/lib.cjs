"use strict";
const log = (s) => console.log(s);
exports.count = function* count(label, n) {
  try {
    for (let i = 0; i < n; i++) {
      log(`${label} yields ${i}`);
      yield i;
    }
  } finally {
    log(`${label} finally`);
  }
};
exports.forever = function* forever() {
  let i = 0;
  try {
    for (;;) yield i++;
  } finally {
    log(`forever finally at ${i}`);
  }
};
exports.set = () => new Set(["x", "y", "z"]);
exports.sum = (...values) => values.reduce((a, b) => a + b, 0);
