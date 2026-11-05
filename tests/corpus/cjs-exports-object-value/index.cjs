// `exports.CST = cst` publishes the dependency's exports OBJECT itself, so a
// requirer of this module reaches the dependency through it.
var cst = require("./parse.cjs");
var state = require("./state.cjs");
exports.CST = cst;
exports.STATE = state;
exports.name = "cst-index";
