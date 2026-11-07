// A wrapper that re-exports another module's whole value: Node's
// `module.exports = require(...)` stores the value the inner module had at
// its own export statement, so later writes to the inner binding stay out.
module.exports = require("./snapshot.cjs");
