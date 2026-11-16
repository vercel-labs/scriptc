// `exports.A = A` in a partial require() cycle: the live exports object
// holds the class itself, so a later read through a module binding answers
// the constructor.
'use strict';

console.log('main start');
const a = require('./a.js');
const b = require('./b.js');
console.log('main', typeof a.A, b.get());
