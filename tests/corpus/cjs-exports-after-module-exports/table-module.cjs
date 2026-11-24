'use strict';

module.exports = { kept: 1 };
exports.dropped = sideEffect();

function sideEffect() {
  console.log('table member evaluated');
  return 2;
}
