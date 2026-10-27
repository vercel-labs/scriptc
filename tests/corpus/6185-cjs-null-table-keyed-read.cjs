// A keyed read of an exported table that starts out null and is filled
// later (iconv-lite's `encodings`). The checker narrows the read to the
// table, while the export's storage keeps the null arm.
'use strict';

/** @type {{ [name: string]: string } | null} */
module.exports.encodings = null;

/** @param {string} name */
function note(name) {
  console.log('key', name);
  return name;
}

/** @param {string} name */
const lookup = function lookup(name) {
  if (!module.exports.encodings) return 'none';
  return module.exports.encodings[note(name)];
};

console.log(lookup('utf8'));
module.exports.encodings = { utf8: 'UTF-8', latin1: 'ISO-8859-1' };
console.log(lookup('utf8'), lookup('latin1'), lookup('ascii'));
