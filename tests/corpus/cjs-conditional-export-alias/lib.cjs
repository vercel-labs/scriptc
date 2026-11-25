// React's index.js shape: the module.exports object is one of two tables,
// chosen when the module runs.
'use strict';

if (process.env.NODE_ENV === 'production') {
  module.exports = require('./prod.cjs');
} else {
  module.exports = require('./dev.cjs');
}
