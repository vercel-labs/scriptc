// A CommonJS member a star re-export and a named re-export both spread: both
// paths resolve to this one binding, so importing it is not ambiguous.
'use strict';

exports.now = function () {
  return 'now-value';
};
