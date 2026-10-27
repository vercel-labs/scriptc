'use strict';

console.log('core: init');

/** @param {string} name */
function label(name) {
  return `<${name}>`;
}

module.exports = { label };
