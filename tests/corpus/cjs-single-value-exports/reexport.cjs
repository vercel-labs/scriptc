'use strict';

// A plain require binding of a single-value module, re-exported whole
// (gopd's index.js): the binding has no storage of its own — it IS the
// required module's whole export.
var $gOPD = require('./leaf.cjs');

module.exports = $gOPD;
