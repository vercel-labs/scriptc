let seen = -1;
exports.register = function () {
  process.on("SIGTSTP", (...args) => {
    seen = args.length;
  });
  return true;
};
exports.seenArgs = function () {
  return seen;
};
