'use strict';
(function () {
  if (1 < 2) {
    module.exports = require('./pick-prod.cjs');
  } else {
    module.exports = require('./pick-dev.cjs');
  }
})();
