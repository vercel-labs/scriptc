// A second module reads the same exports object as its own namespace value.
const lib = require("./lib.cjs");
module.exports = { proto: Object.getPrototypeOf(lib), answer: lib.answer };
