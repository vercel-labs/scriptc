// A dependency whose exports change while the program runs.
exports.ready = false;
exports.mark = function mark() {
  exports.ready = true;
};
