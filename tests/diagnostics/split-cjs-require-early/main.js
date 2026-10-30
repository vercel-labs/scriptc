// A split require binding (`let lib;` then `lib = require(...)`) that code
// above the assignment can reach: Node reads undefined there, a value the
// compiled module alias cannot hold, so the assignment keeps a named SC1013
// fence. Assigned before any such code, the binding compiles
// (tests/corpus/split-cjs-require-binding).
'use strict';

let lib;
console.log('boot', helper());
lib = require('./lib.js');

// The same with the require parenthesized.
let wrapped;
console.log('peek', wrapped === undefined);
wrapped = (require('./lib.js'));

function helper() {
  return lib === undefined ? 'not loaded' : lib.greet('late');
}

console.log(helper());
