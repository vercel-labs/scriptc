// A table the conditional alias could name. Its exported function assigns a
// member after the module ran, as Node's shared exports object allows.
'use strict';
exports.mode = 'one';
exports.setMode = function (mode) {
  exports.mode = mode;
};
