const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const url = require('node:url');
const crypto = require('node:crypto');
const events = require('node:events');
const util = require('node:util');

console.log(Object.keys(zlib).join(','));
console.log(Object.keys(zlib).length);
console.log(Object.keys(path).join(','));
console.log(Object.keys(url).join(','));
console.log(Object.keys(util.types).join(','));
console.log(Object.keys(events).join(','));
console.log(Object.keys(fs).includes('promises'), Object.keys(fs).includes('F_OK'));
console.log(Object.keys(crypto).includes('createHash'));
console.log(Object.keys(os).every((k) => typeof k === 'string'));

// The answer is the same expression twice, and does not disturb the module.
const first = Object.keys(zlib);
const second = Object.keys(zlib);
console.log(first.length === second.length, first[0] === second[0]);
