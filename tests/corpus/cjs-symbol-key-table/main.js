// Symbol-keyed class fields and methods whose keys come from a CommonJS
// key table in another module: field declarations, constructor and method
// assignments, a base method calling a subclass's symbol-keyed method,
// reads through the table from a third module, and inspect output.
'use strict';

const { inspect } = require('node:util');
const UpperQueue = require('./upper-queue');
const { kState, kSize, kName } = require('./symbols');

const q = new UpperQueue('jobs');
console.log(q.push('a'), q.push('b'), q.push(3));
console.log(q.state, q[kSize], q[kName]);
console.log(q.drain());
console.log(q.state, q[kSize], q[kState]);
q[kName] = 'renamed';
console.log(q.state);
console.log(inspect(q));
console.log(Object.keys(q));
