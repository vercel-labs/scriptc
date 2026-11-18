// react/index.js: module.exports is one of two required tables, chosen when
// the module runs, so importers read the chosen table's members.
'use strict';

if (process.env.NODE_ENV === 'production') {
  module.exports = require('./prod.cjs');
} else {
  module.exports = require('./dev.cjs');
}
