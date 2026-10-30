var whole;
whole = require("./whole.cjs");
console.log("extra: before", whole.extra, whole(9));
module.exports = whole;
module.exports.extra = 1;
console.log("extra: after", whole.extra, module.exports.extra);
