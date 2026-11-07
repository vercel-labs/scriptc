// A wrapper that re-exports a split require binding (`var m; m = require()`):
// the stored value is what the binding held at this statement.
var snap;
snap = require("./snapshot.cjs");
module.exports = snap;
