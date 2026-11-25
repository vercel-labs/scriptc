// @normalize-pid
// An effectful initializer in a partial require() cycle's export table is
// evaluated once, and the value both the static export and the live exports
// object hold is that single evaluation.
'use strict';

console.log('main start');
const a = require('./a.js');
console.log('main', a.value);
