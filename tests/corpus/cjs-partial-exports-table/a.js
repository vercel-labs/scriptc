'use strict';

console.log('a: start');
const b = require('./b.js');
console.log('a sees', b.B);
module.exports = { A: 1 };
