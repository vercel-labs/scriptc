// The same choice taking the other arm when the variable is unset.
'use strict';

if (process.env.CJS_DIFFERING_TABLE === 'full') {
  module.exports = require('./full.cjs');
} else {
  module.exports = require('./lean.cjs');
}
