var useJson = true;

if (useJson) {
  module.exports = { format: "json" };
  module.exports.read = function () {
    return "read:" + module.exports.format;
  };
} else {
  module.exports = { format: "text" };
}
