// A var require binding that code above the require can reach: Node reads
// undefined there (the var is hoisted, the require has not run), a value
// the compiled module alias cannot hold — the require keeps a named SC1013
// fence. A const or let binding compiles with an initialization check
// instead (tests/corpus/6141-cjs-require-tdz-checked).
'use strict';

console.log('boot', helper());
var lib = require('./lib.js');

function helper() {
  return lib.greet('early');
}

console.log(helper());
