'use strict';

console.log('b start');
const a = require('./a.js');
console.log('b sees', a.value);
exports.late = 'L';
