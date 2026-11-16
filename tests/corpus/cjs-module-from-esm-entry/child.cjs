console.log("cjs", typeof require.main, require.main === undefined);
console.log("cjs module object", typeof module, typeof module.parent);
module.exports = 1;
