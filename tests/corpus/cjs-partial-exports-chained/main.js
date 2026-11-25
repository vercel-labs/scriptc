// A chained export assignment (`exports.late = exports.later = value`) in a
// partial require() cycle: every member of the chain lands in the live
// exports object, so a module reading either through its binding after the
// cycle sees the value.
'use strict';

console.log('main start');
const a = require('./a.js');
const b = require('./b.js');
console.log('main', a.late, a.later, b.get());
