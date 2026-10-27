// A CommonJS module's top-level `let x;` bindings that a published
// function can reach before their declarations run. Node only throws
// for an access that really happens before the declaration; once the
// module body has run, every call sees the bindings (undefined until
// assigned).
'use strict';

const parse = require('./lib.js');

console.log(parse('a'), parse('b'));
console.log(parse('c'));
