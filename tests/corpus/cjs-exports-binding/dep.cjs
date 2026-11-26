// dep.cjs: the CommonJS `exports` binding is the same object as
// module.exports, and properties set through it are what the requiring
// module sees.
exports.name = "dep";
exports.answer = 42;
console.log("dep", typeof exports, exports === module.exports);
