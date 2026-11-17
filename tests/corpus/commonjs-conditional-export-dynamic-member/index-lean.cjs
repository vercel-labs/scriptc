// The lean arm runs unless the variable selects the full table.
'use strict';

if (process.env.CJS_DYN_TABLE === 'full') {
  module.exports = require('./full.cjs');
} else {
  module.exports = require('./lean.cjs');
}
