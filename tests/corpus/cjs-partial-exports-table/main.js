// @normalize-pid
// A require() cycle whose module replaces module.exports with a table after
// requiring into the cycle: the earlier requirer holds the original exports
// object, so its member read is undefined (Node warns) even though the
// replacement table is what later require() calls answer.
'use strict';

console.log('main: start');
const a = require('./a.js');
console.log('main sees', a.A);
