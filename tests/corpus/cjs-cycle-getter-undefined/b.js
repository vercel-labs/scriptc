'use strict';
const a = require("./a.js");
exports.during = a.lazy;
exports.later = function () {
  return a.lazy;
};
