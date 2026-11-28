var verbose = true;

if (verbose) {
  module.exports = function (label) {
    return "exit:" + label;
  };
  module.exports.unload = function () {
    return "unload";
  };
  module.exports.signals = function () {
    return ["SIGINT", "SIGTERM"];
  };
} else {
  module.exports = function () {
    return "noop";
  };
}
