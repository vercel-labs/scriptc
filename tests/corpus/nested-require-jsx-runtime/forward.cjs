// Node hands out the same exports object for a module and for one that
// forwards it, so a nested require of either answers one object.
module.exports = require("./react.cjs");
