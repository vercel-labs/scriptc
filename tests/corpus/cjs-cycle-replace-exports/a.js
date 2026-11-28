'use strict';
// A member written before the require is visible to the partner; the
// module then replaces module.exports, which the partner's captured object
// does not see (Node's per-requirer identity).
exports.first = 1;
const b = require("./b.js");
module.exports = { replaced: 2 };
module.exports.after = 3;
