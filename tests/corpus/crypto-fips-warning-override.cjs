// crypto.fips reports DEP0093 through process.emitWarning on its first read,
// so a replacement that throws makes the read throw where the surrounding
// try catches it. The report is spent either way: the read after the
// original replacement is back answers its value and reports nothing.
'use strict';
const crypto = require('node:crypto');

const original = process.emitWarning;
process.emitWarning = () => {
  throw new Error('warning refused');
};
try {
  console.log('fips', crypto.fips);
} catch (e) {
  console.log('caught', e.name, e.message);
}
process.emitWarning = original;
console.log('fips after', crypto.fips);
