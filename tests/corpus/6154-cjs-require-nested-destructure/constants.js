exports.MAX_LENGTH = 1024;
exports.SEP = "/";
exports.helper = function (x) {
  return x * 3;
};
exports.bump = function () {
  exports.MAX_LENGTH = 2048;
};
