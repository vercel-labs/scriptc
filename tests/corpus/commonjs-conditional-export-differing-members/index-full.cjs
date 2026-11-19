// react/index.js's shape with tables that export different members: the
// full table has `extra`, the lean one does not, so Node answers undefined
// for it when the lean arm runs.
'use strict';

if (process.env.CJS_DIFFERING_TABLE === 'lean') {
  module.exports = require('./lean.cjs');
} else {
  module.exports = require('./full.cjs');
}
