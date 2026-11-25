'use strict';
// A Buffer that a typed file read answers — the program makes no buffer.*
// call at all — still answers its methods by name through a
// checked-dynamic read: the member table installs for it, so a stored
// method is a function and runs with the receiver it is called on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.tmpdir(), 'scriptc-fs-buffer-members-' + process.pid + '.bin');
fs.writeFileSync(file, 'hello world');
const buf = fs.readFileSync(file);
fs.unlinkSync(file);

// A Buffer.prototype method that a plain Uint8Array does not have.
const name = ['readUIn', 't32LE'].join('');
const method = buf[name];
console.log('stored', typeof method);
console.log('at0', method.call(buf, 0));

// The same read through a value that reaches the program from a function
// keeps answering a method.
const read = (b) => b;
const again = read(buf)[name];
console.log('again', typeof again, again.call(buf, 4));
