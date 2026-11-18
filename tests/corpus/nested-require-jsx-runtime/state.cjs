exports.value = "first";
exports.set = function (v) {
  exports.value = v;
};
var reads = 0;
exports.table = {
  get counted() {
    reads++;
    return reads;
  },
};
