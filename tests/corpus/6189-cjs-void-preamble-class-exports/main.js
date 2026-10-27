// tsc's CommonJS export preamble (`exports.A = exports.B = void 0;`) ahead
// of class exports (chardet's encoding modules): the class read through
// the module object is the class itself, for every name in the chain.
"use strict";
const lib = require("./lib.js");

const list = [new lib.ShiftJis(), new lib.Big5()];
for (const rec of list) console.log(lib.describe(rec), rec instanceof lib.ShiftJis);
console.log(typeof lib.Big5, new lib.Big5().name());
