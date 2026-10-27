// @exit: 1
// A hoisted function called above the require reads the binding before
// the require ran: Node throws "Cannot access 'greet' before
// initialization" there, uncaught, and nothing after it runs.
'use strict';

console.log('start');
console.log('boot', helper());
const { greet } = require('./lib.js');

function helper() {
  return greet('early');
}

console.log('unreachable', helper());
