console.log("make-logger: evaluated");
module.exports = function (ns) {
  return function (msg) {
    return ns + ": " + msg;
  };
};
