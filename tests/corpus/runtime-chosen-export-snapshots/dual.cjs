'use strict';
// module.exports starts as the object top-level `this` and `exports` name.
var before = this === module.exports;
var exportsBefore = exports === module.exports;
if (1 < 2) {
  module.exports = function chosen() {
    return 'chosen';
  };
}
var after = this === module.exports;
var exportsAfter = exports === module.exports;
console.log('identity', before, exportsBefore, after, exportsAfter);
