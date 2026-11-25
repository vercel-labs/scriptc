console.log("split: before");
console.log("split: initial exports", exports.n, typeof exports.n);
var lib;
lib = (require("./lib.cjs"));
console.log("split: after", lib.n);
module.exports = (lib);
console.log("split: retained exports", exports.n, exports.render, typeof exports.render);
console.log("split: forwarded exports", module.exports.n);
console.log("split: done");
