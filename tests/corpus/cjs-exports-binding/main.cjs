// The CommonJS `exports` binding: the same object as module.exports, its
// properties are the module's exports, and a requiring module sees them.
console.log("main", typeof exports, exports === module.exports);
exports.early = "e";
console.log("own", exports.early);
const dep = require("./dep.cjs");
console.log(dep.name, dep.answer);
