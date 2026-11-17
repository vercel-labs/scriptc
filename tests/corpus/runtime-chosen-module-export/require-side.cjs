'use strict';
// The CommonJS spellings: a binding read and an inline require value.
const bound = require('./pick-cjs.cjs');
exports.bound = function () {
  return bound('bound');
};
exports.inline = function () {
  return require('./pick-cjs.cjs')('inline');
};
