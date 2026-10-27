// A require cycle (comparator.js ↔ range.js) whose modules settle their
// exports before they require anything, and use each other only inside
// methods: the cycle evaluates in Node's order and each binding is the
// other module's class.
'use strict';

console.log('main: start');
const Comparator = require('./comparator.js');
const Range = require('./range.js');

const range = new Range('1.0.0 2.0.0');
console.log(range.has('2.0.0'), range.has('3.0.0'));
const first = range.first();
console.log(first instanceof Comparator, first.value, first.within('2.0.0 1.0.0'));
console.log(new Comparator('9').within('1 2'), String(Comparator.ANY));
