'use strict';
const dual = require('./dual.cjs');
console.log(dual());
const late = require('./late.cjs');
console.log(late(), typeof late.swap);
late.swap();
console.log(late());
console.log(require('./late.cjs')());
