// Node checks the caller of the deprecated Buffer constructor for its first
// 10000 calls only: once a dependency under node_modules has made them, the
// program's own calls report no DEP0005.
"use strict";
process.on("warning", (w) => console.log("listener", w.code));
const legacy = require("legacy-buf");

console.log(legacy.many(10000));
console.log(new Buffer("after"), Buffer(1));
setTimeout(() => console.log("timer"), 0);
