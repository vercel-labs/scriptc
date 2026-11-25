'use strict';
const dual = require('./dual.cjs');
console.log(dual());
const late = require('./late.cjs');
console.log(late(), typeof late.swap);
// A separately declared function reads the binding's stored value, not the
// dependency's current export.
function peek() {
  return late();
}
late.swap();
console.log(late());
console.log('late-function', peek());
console.log(require('./late.cjs')());
// A binding created after the replacement answers the replacement, and a
// function-local binding holds the value its own require answered.
const after = require('./late.cjs');
console.log('late-after', after());
function local() {
  const inner = require('./late.cjs');
  return inner();
}
console.log('late-local', local());
