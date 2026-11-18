console.log("cjs", typeof require.main, require.main === undefined);
const main = require.main;
console.log("cjs typeof forms", typeof (require.main), typeof main, typeof require.main);
console.log("cjs module object", typeof module, typeof module.parent);
module.exports = 1;
