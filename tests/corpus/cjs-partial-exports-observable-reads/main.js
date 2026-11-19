// @normalize-pid
'use strict';

console.log('main start');
const a = require('./a.js');
console.log('main sees', a.ready, a.late);
