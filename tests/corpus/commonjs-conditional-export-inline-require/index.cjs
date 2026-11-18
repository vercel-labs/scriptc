'use strict';
if (process.env.COMMONJS_CONDITIONAL_INLINE_MODE === 'production') {
  module.exports = require('./prod.cjs');
} else {
  module.exports = require('./dev.cjs');
}
