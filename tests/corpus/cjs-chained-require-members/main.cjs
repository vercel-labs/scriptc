// `module.exports` takes the required module's exports object, and the member
// export below extends that same object.
var whole = module.exports = require("./lib.cjs");
module.exports.extra = "added";
const reader = require("./reader.cjs");
console.log(whole.tag, whole.extra, reader.tag, reader.extra);
