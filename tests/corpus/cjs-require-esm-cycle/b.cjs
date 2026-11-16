'use strict';

console.log('b: start');
const main = require('./main.mjs');
console.log('b: got', main.value);
module.exports = { b: true };
