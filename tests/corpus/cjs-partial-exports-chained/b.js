'use strict';

const a = require('./a.js');
exports.get = function () {
  return a.late + '/' + a.later;
};
