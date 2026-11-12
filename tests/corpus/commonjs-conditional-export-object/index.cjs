// react/index.js: a module whose whole export object is one of two requires,
// chosen when the module runs. Node stores the chosen module's exports object
// in module.exports, so every requirer reads that table's members.
'use strict';
if (process.env.CJS_CONDITIONAL_EXPORT_MODE === 'production') {
  module.exports = require('./prod.cjs');
} else {
  module.exports = require('./dev.cjs');
}
