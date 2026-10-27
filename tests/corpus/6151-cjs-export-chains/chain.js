let evaluations = 0;
function make() {
  evaluations++;
  return function () {
    return "shared";
  };
}
exports.a = exports.b = make();
module.exports.c = exports.d = module.exports.e = 5;
exports.evaluations = evaluations;
