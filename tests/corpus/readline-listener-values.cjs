'use strict';
// readline listeners that are function values rather than inline
// functions (test/common's mustCall wrappers return such values), and
// listeners that return a value, which Node ignores.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Readable } = require('stream');

function counted(label, fn) {
  let calls = 0;
  process.on('exit', () => console.log(label, 'calls', calls));
  return function (...args) {
    calls++;
    return fn.apply(this, args);
  };
}

const lines = [];
const rl = readline.createInterface({ input: Readable.from(['one\ntwo\n', 'three']) });
rl.on('line', counted('line', (line) => lines.push(line)));
rl.on('line', (line) => line.length);
rl.on('close', counted('close', () => console.log('lines', JSON.stringify(lines))));

const missing = path.join(__dirname, 'readline-listener-values-missing.txt');
const broken = readline.createInterface({ input: fs.createReadStream(missing), crlfDelay: Infinity });
broken.on('error', counted('error', (err) => console.log('error', err.code, err.message.includes('ENOENT'))));
