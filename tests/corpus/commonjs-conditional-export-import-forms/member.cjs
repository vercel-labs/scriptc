// scheduler's shape: a member attached to the exports object inside a branch,
// so which function the member holds depends on the environment.
'use strict';

if (typeof performance === 'object') {
  exports.now = function () {
    return performance.now() > 0;
  };
  exports.clock = 'performance';
} else {
  exports.now = function () {
    return Date.now() > 0;
  };
  exports.clock = 'date';
}

exports.from = function () {
  return 'member';
};
