// @normalize-pid
// A require() cycle whose modules assign exports AFTER the require: a
// module required mid-cycle gets the exports object as it stands, so a
// member not yet assigned reads undefined (Node warns once for the miss),
// and one assigned later is visible to everyone holding the object.
'use strict';

console.log('main: start');
const a = require('./a.js');
const b = require('./b.js');
console.log('main sees', a.early, a.late, b.fromB);
