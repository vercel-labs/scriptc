'use strict'
const constants = require("./constants.js");
exports = module.exports = {}
const src = [];
const t = {};
exports.src = src;
exports.t = t;
exports.tokens = [];
function createToken(name, value) {
  t[name] = src.length;
  src.push(value);
  exports.tokens.push(name);
}
createToken("FULL", "^" + constants.VERSION + "$");
createToken("LOOSE", "v?" + constants.VERSION);
