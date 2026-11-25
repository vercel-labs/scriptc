// @requires-libnode
// Annex B.3.2 in a sloppy Annex B block function: a block-level function
// declaration also creates a var-like binding in the enclosing function, so
// the name is visible before the block runs and after it.
const annexb = require("./annexb.js");

console.log(annexb.reached(true), annexb.reached(false));
console.log(annexb.beforeBlock(), annexb.afterBlock());
console.log(annexb.looped());
