'use strict';
// Inline require() member reads of a module whose whole export is one of two
// static tables: the read resolves through the selected table's member slot.
console.log(require('./index.cjs').mode);
const pick = require('./index.cjs').pick;
console.log(pick());
const index = require('./index.cjs');
console.log(index.mode, index.pick());
