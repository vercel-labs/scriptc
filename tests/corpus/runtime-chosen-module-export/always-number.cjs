'use strict';
if (1 < 2) {
  module.exports = 42;
} else {
  module.exports = function () {
    return 'never';
  };
}
