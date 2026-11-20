'use strict';

console.log('b: start');
const a = require('./a.js');
console.log('b sees', a.A);
module.exports = { B: 2 };
