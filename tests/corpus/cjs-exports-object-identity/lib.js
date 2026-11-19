"use strict";
exports.count = 0;
exports.bump = function () {
  exports.count = exports.count + 1;
  return exports.count;
};
exports.isSelf = function () {
  return this === module.exports;
};
