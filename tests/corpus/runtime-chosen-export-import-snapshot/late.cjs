'use strict';
// An exported function replaces module.exports after the module evaluated.
// A binding that required this module keeps the value it read.
var self = this;
function first() {
  return 'first';
}
function swap() {
  module.exports = function second() {
    return 'second';
  };
}
first.swap = swap;
if (1 < 2) {
  module.exports = first;
} else {
  module.exports = function other() {
    return 'other';
  };
}
console.log('identity-after', self === module.exports);
