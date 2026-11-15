const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const util = require('node:util');
const stream = require('node:stream');

const KEY = 'deflateSync';

console.log(zlib.hasOwnProperty('createGzip'), zlib.hasOwnProperty('nope'));
console.log(zlib.hasOwnProperty('toString'), zlib.hasOwnProperty('hasOwnProperty'));
console.log(zlib.hasOwnProperty(KEY), zlib.hasOwnProperty(''));
console.log(fs.hasOwnProperty('F_OK'), fs.hasOwnProperty('promises'), fs.hasOwnProperty('readFileSync'));
console.log(path.hasOwnProperty('join'), path.hasOwnProperty('toString'));
console.log(assert.hasOwnProperty('ok'), assert.hasOwnProperty('length'), assert.hasOwnProperty('name'));
console.log(util.types.hasOwnProperty('isPromise'), util.types.hasOwnProperty('isPromiseX'));
console.log(stream.hasOwnProperty('Readable'), stream.hasOwnProperty('on'));

// Answers are plain booleans and do not read through the prototype chain.
const answers = [zlib.hasOwnProperty('crc32'), zlib.hasOwnProperty('valueOf')];
console.log(typeof answers[0], answers[0], answers[1]);
