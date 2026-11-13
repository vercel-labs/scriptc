// module.exports is the selected table's own exports object, so a member that
// table later assigns is visible to this module's requirers.
'use strict';
if (process.env.CJS_LATE_WRITE_MODE === 'one') {
  module.exports = require('./one.cjs');
} else {
  module.exports = require('./two.cjs');
}
