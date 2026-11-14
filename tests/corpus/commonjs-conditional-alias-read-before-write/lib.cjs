// react-dom/server.node.js's shape, with a read ahead of the branch: Node
// executes the read while the variable is still undefined, so `l.mode` throws
// a TypeError and nothing after it runs. The read is caught here so the
// program reports the error instead of aborting.
'use strict';
var l;
try {
  exports.early = l.mode;
} catch (err) {
  exports.early = err.name + ': ' + err.message;
}
if (process.env.CJS_ALIAS_MODE === 'one') {
  l = require('./one.cjs');
} else {
  l = require('./two.cjs');
}
exports.mode = l.mode;
