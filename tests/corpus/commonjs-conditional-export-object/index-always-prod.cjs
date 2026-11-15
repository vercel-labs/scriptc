// The same shape with a condition that is true, so the other arm runs.
'use strict';
if (1 < 2) {
  module.exports = require('./prod.cjs');
} else {
  module.exports = require('./dev.cjs');
}
