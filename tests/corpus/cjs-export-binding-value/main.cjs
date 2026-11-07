// A CommonJS module whose whole export is a binding rather than a literal
// or a table: Node copies the binding's value at the export statement.
'use strict';
const $defineProperty = require('./probe.cjs');
const count = require('./counted.cjs');

console.log('E1', typeof $defineProperty);
console.log('E2', $defineProperty === Object.defineProperty);
const target = {};
$defineProperty(target, 'a', { value: 1, enumerable: true });
console.log('E3', target.a, JSON.stringify(target));

console.log('C1', count);
