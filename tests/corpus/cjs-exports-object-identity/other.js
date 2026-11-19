const lib = require("./lib");
lib.fromOther = "o";
exports.get = function () {
  return lib;
};
exports.fresh = function () {
  return require("./lib");
};
