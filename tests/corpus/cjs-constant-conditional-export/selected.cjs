if (true)
  module.exports = function selected() {
    return "selected";
  };
else
  module.exports = function skipped() {
    return "wrong";
  };
