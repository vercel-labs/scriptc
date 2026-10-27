'use strict';

/** @param {{ loose?: boolean } | undefined} options */
function parseOptions(options) {
  return options && options.loose ? 'loose' : 'strict';
}

module.exports = parseOptions;
