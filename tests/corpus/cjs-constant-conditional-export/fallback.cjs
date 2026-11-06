if (false) {
  module.exports = function unused() {
    return "wrong";
  };
} else {
  module.exports = function fallback() {
    return "fallback";
  };
}
