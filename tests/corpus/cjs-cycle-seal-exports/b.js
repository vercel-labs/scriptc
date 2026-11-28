'use strict';
const a = require("./a.js");
exports.during = a.second === undefined;
exports.later = function () {
  return a.second;
};
