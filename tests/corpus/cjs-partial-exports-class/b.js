'use strict';

const a = require('./a.js');
exports.get = function () {
  return typeof a.A;
};
