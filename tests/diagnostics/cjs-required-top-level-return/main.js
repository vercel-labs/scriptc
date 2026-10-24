// A top-level return in a CommonJS module the program requires: the
// exports assigned after it may stay undefined, which the module's typed
// export storage cannot hold, so the return is refused. The entry module's
// own top-level return compiles (tests/corpus/8271-cjs-top-level-return.cjs).
'use strict';

const lib = require('./lib.js');
console.log(lib.ready, lib.value);
