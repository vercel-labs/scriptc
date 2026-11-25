// Reads builtin globals by name off a value another module stored.
var root = require("./root.cjs");

exports.URLClass = root.URL;
exports.encoder = typeof root.TextEncoder;
exports.describe = function (holder) {
  return [
    typeof holder.Headers,
    holder.Headers === Headers,
    holder.Promise === Promise,
    holder["Symbol"] === Symbol,
    typeof holder.noSuchName,
  ].join(" ");
};
