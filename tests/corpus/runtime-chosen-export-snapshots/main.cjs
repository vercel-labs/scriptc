'use strict';
const dual = require('./dual.cjs');
console.log(dual());
const late = require('./late.cjs');
console.log(late(), typeof late.swap);
late.swap();
console.log(late());
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
