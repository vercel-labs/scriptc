// react/index.js's shape with a second assignment in the same arm: the arm
// selects the full table, then replaces it with the lean one, which lacks
// `extra`. Node hands out the lean table, so `extra` is undefined.
'use strict';

if (process.env.CJS_TABLE_REPLACE !== 'never') {
  module.exports = require('./full.cjs');
  module.exports = require('./lean.cjs');
} else {
  module.exports = require('./full.cjs');
}
