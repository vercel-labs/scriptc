exports.zeta = 1;
exports.alpha = "two";
exports.mid = function () {
  return 3;
};
exports.alpha = "again";
function later() {
  exports.beta = [4];
}
exports.later = later;
