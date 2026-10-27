"use strict";
function format(value) {
  return "[" + value + "]";
}
function shout(value) {
  return String(value).toUpperCase();
}
exports = module.exports = format;
exports.shout = shout;
exports.version = "1.2.3";
