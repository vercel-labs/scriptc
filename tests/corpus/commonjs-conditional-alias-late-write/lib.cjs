// react-dom/server.node.js's shape: `l` is the selected table's own exports
// object, so a member that table assigns after the branch shows through
// `l.mode`. A write to the table the branch did not select does not.
'use strict';
var l;
if (process.env.CJS_ALIAS_LATE_WRITE_MODE === 'one') {
  l = require('./one.cjs');
} else {
  l = require('./two.cjs');
}
exports.before = l.mode;
require('./one.cjs').setMode('one-late');
exports.afterOther = l.mode;
require('./two.cjs').setMode('two-late');
exports.afterSelected = l.mode;
var setMode = l.setMode;
setMode('through-alias');
exports.afterAlias = l.mode;
