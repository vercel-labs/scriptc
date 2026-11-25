// A require binding that re-exports a whole-export snapshot: the wrapper's
// exports IS the stored value, so requirers read the same storage.
const snap = require("./snapshot.cjs");
module.exports = snap;
