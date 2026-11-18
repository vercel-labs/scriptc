"use strict";
// React's index.js shape: the whole export is chosen at run time between two
// static tables. The wrapper's `value` slot must take the chosen table's
// checked-dynamic value, not the union of the initializer types.
if (process.argv.length > 0) {
  module.exports = require("./a.cjs");
} else {
  module.exports = require("./b.cjs");
}
