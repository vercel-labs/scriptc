// Nested patterns under a named export of a program module destructure
// that export's value at the require (a snapshot), while plain keys stay
// live bindings to the export.
console.log("main: start");
const { codes: { ERR_ONE, ERR_TWO }, AbortError, version } = require("./errors.js");
console.log(ERR_ONE.code, ERR_TWO.code, new AbortError().name, version);
const errors = require("./errors.js");
errors.codes.ERR_ONE = { code: "replaced" };
console.log(ERR_ONE.code, errors.codes.ERR_ONE.code);
// Destructuring a module BINDING snapshots its exports the same way.
const constants = require("./constants.js");
const { MAX_LENGTH, SEP: sep, helper } = constants;
constants.bump();
console.log(MAX_LENGTH, constants.MAX_LENGTH, sep, helper(2));
