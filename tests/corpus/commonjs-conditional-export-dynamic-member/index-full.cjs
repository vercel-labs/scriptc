// The full arm runs unless the variable selects the lean table.
'use strict';

if (process.env.CJS_DYN_TABLE === 'lean') {
  module.exports = require('./lean.cjs');
} else {
  module.exports = require('./full.cjs');
}
