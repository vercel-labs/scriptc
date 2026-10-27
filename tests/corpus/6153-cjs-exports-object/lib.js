exports.lookup = function (ext) {
  return "application/" + ext;
};
exports.contentType = function (ext) {
  return exports.lookup(ext) + "; charset=utf-8";
};
exports.describe = function () {
  return module.exports.lookup("xml");
};
// A later reassignment is what member calls see from then on.
exports.lookup = function (ext) {
  return "text/" + ext;
};
