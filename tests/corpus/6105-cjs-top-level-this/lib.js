// A required CommonJS module sees its own exports object as `this`, and the
// UMD test for a CommonJS host takes the module.exports branch.
const kind = typeof this;
let host = "global";
if (typeof module !== "undefined" && module.exports) host = "commonjs";
(function (root) {
  console.log("lib wrapper root:", typeof root, root ? "truthy" : "falsy");
})(this);
exports.describe = function () {
  return kind + " " + host;
};
