'use strict';
if (process.env.RUNTIME_CHOSEN_EXPORT_MODE === 'production') {
  module.exports = 42;
} else {
  module.exports = function () {
    return 'callable';
  };
}
