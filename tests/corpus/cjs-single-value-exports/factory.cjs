'use strict';

// The chained spelling with a factory value: module.exports is the returned
// object, and a member attached afterwards lands on that same object.
var settings = (module.exports = makeSettings());

function makeSettings() {
  return { mode: 'basic' };
}

module.exports.turbo = true;
console.log('factory in-file:', settings.mode, module.exports.turbo);
