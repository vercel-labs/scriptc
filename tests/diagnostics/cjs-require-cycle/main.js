// A require cycle whose module exports only after requiring into the
// cycle: Node hands B the PARTIAL exports of A mid-init, a
// partially-initialized-module observation the export-global model cannot
// represent — the cycle keeps the named SC1016 fence. (A cycle whose
// modules export first compiles: tests/corpus/6145-cjs-require-cycle.)
'use strict';

console.log('main: start');
const { A } = require('./a.js');
console.log(A);
