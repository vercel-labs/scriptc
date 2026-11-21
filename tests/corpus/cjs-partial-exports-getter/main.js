// A getter in a partial require() cycle's export table: the live exports
// object carries the accessor, so reads through a module binding run the
// getter like Node's exports object does.
'use strict';

console.log('main start');
const a = require('./a.js');
console.log('main sees', a.value);
