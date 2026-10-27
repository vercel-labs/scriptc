'use strict';

console.log('debug: init');

/** @param {...unknown} args */
function debug(...args) {
  console.log('debug:', args.join(' '));
}

module.exports = { debug };
