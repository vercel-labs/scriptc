'use strict';

/** @param {number} n */
function double(n) {
  return n * 2;
}

const VERSION = '3.1.4';

let bumps = 0;

module.exports = {
  double,
  VERSION,
  /** @returns {number} */
  bump() {
    bumps += 1;
    return bumps;
  },
};
