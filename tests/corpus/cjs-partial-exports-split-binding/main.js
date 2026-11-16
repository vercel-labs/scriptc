// @normalize-pid
// A split require binding (`var a; a = require("./a.js")`) in a partial
// cycle keeps the exports object its require answered: a later
// `module.exports = { … }` in the target is not visible through it.
'use strict';

console.log('main start');
const a = require('./a.js');
const b = require('./b.js');
console.log('main', a.A, b.B());
