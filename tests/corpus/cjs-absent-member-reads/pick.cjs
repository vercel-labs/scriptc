'use strict';

// A module whose whole export is chosen at run time between two static
// tables: the chosen table's members fill this module's exports, and a
// member neither table assigned is absent here too.
if (process.argv.length > 1000) {
  module.exports = require('./prod-a.cjs');
} else {
  module.exports = require('./prod-b.cjs');
}
