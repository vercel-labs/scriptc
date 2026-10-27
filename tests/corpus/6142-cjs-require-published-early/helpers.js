'use strict';

console.log('helpers: init');

/** @param {string} s */
function normalize(s) {
  return s.replace(/\/+/g, '/');
}

module.exports = { normalize };
