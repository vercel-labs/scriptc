'use strict';
// A module whose whole export is one of two single-value modules, chosen when
// it runs (the UMD / conditional-export shape). Node's require and default
// import answer whatever the executed branch stored in module.exports.
if (process.env.RUNTIME_CHOSEN_EXPORT_MODE === 'production') {
  module.exports = require('./pick-prod.cjs');
} else {
  module.exports = require('./pick-dev.cjs');
}
