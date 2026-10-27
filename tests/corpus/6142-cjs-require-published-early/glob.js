'use strict';

// The glob@7 layout with var: export first, then var requires, a runnable
// statement between them, and properties stored on the exported function.
module.exports = glob;
glob.sync = globSync;

var parseOptions = require('./parse-options.js');
var mode = parseOptions({ loose: true });
var helpers = require('./helpers.js');

/** @param {string} pattern */
function glob(pattern) {
  return `${mode}:${helpers.normalize(pattern)}`;
}

/** @param {string} pattern */
function globSync(pattern) {
  return helpers.normalize(pattern).toUpperCase();
}
