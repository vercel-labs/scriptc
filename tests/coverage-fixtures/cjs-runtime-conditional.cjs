if (process.env.SCRIPTC_TEST_ENV === "from-harness") {
  module.exports = function first() {
    return "first";
  };
} else {
  module.exports = function second() {
    return "second";
  };
}
