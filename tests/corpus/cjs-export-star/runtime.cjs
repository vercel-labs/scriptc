'use strict';
if (process.env.NODE_ENV === 'production') {
  module.exports = require('./impl-prod.cjs');
} else {
  module.exports = require('./impl-dev.cjs');
}
