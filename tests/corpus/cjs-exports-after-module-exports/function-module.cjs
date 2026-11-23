'use strict';

// Node replaces module.exports with the function; the later `exports.hello`
// still references the replaced object, so the member is discarded. Its
// value is still evaluated.
module.exports = function (config) {
  return { config: config };
};
exports.hello = function () {
  console.log('discarded member evaluated');
  return 1;
};
module.exports.default = module.exports;
module.exports.version = '1.0';
