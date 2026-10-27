// parseInt over a value that may be missing, as JavaScript writes it with
// an environment variable fallback: Node parses the text "undefined".
'use strict';
const port = parseInt(process.env.SCRIPTC_UNSET_PORT_VARIABLE, 10) || 8125;
console.log(port);
console.log(parseInt(process.env.SCRIPTC_TEST_ENV, 36));
const options = {};
console.log(parseInt(options.missing, 10), parseInt(options.missing, 36));
