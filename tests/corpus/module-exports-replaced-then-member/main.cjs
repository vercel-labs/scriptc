/* After `module.exports = …`, a member write targets the replacement: the
 * module's original top-level `this` object is a separate object Node never
 * writes it to. */
const original = this;
module.exports = { replaced: true };
module.exports.extra = "added";
console.log(
  "keys",
  Object.keys(original).join(",") || "none",
  original.extra,
  module.exports.extra,
);
