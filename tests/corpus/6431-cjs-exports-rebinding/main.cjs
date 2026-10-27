// `exports = module.exports = value` rebinds the wrapper's exports binding
// too, so members attached through `exports` afterwards are exported.
const format = require("./lib.cjs");
const { shout, version } = require("./lib.cjs");
console.log(format("a"), shout("b"), version);
console.log(typeof format, typeof shout);
// A module that re-exports another module's exports and adds a member.
const { extra, shout: loud } = require("./extended.cjs");
console.log(extra, loud("c"));
