'use strict';

console.log('a: start');
exports.early = 'a-early';
const b = require('./b.js');
console.log('a sees', b.fromB);
exports.late = 'a-late';
