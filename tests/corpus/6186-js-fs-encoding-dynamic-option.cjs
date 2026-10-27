// readFileSync with a `{ encoding }` literal whose value comes from an
// untyped source (dotenv's configDotenv): the option object is checked
// into the record the checker describes.
'use strict';

const fs = require('fs');

/**
 * @param {string} file
 * @param {any} options
 */
function read(file, options) {
  let encoding = 'utf8';
  if (options && options.encoding) encoding = options.encoding;
  return fs.readFileSync(file, { encoding });
}

const latin1 = read(__filename, { encoding: 'latin1' });
const utf8 = read(__filename, null);
if (typeof latin1 === 'string' && typeof utf8 === 'string') {
  console.log(latin1.length === utf8.length, utf8.split('\n')[0]);
}
