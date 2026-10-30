// A split require binding (`var b; b = require("./b.js")`) whose require
// closes a CommonJS cycle that top-level code can observe: b.js reads a.js's
// partial exports while a.js is still evaluating, which the compiled export
// table does not model. Preflight refuses it with SC1016, as it refuses the
// `const b = require("./b.js")` form; tests/corpus/split-cjs-require-cycle
// compiles the cycle shape both forms admit.
exports.early = 'a-early';
var b;
b = require('./b.js');
exports.late = 'a-late';
console.log('a sees', b.fromB, b.readA());
