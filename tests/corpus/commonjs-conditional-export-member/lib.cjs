// scheduler's shape: exports.now assigned inside each arm of a feature test.
// Node's exports object takes the member write in any position, so the module
// exports the member the arm that ran attached — nothing before the branch.
'use strict';
if (typeof performance === 'object') {
  exports.now = function () {
    return performance.now() >= 0;
  };
  exports.clock = 'performance';
} else {
  exports.now = function () {
    return Date.now() >= 0;
  };
  exports.clock = 'date';
}
