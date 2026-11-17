'use strict';
if (process.env.RUNTIME_CHOSEN_EXPORT_MODE === 'production') {
  module.exports = require('./class-prod.cjs');
} else {
  module.exports = require('./class-dev.cjs');
}
