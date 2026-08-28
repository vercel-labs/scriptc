// The CommonJS module globals and the tamper-guard prologue, JS-input:
// __dirname/__filename are per-module compile-time constants (the file's
// real location — Node's values exactly when the tree runs in place), and
// `const process = globalThis.process` is pure alias plumbing — reads
// through the snapshot, through globalThis, and through `global` all land
// on the same lowered process surface.
'use strict';
const process = globalThis.process;
const path = require('path');
const os = require('os');
const fs = require('fs');

console.log('G1', typeof __dirname, typeof __filename);
console.log('G2', __filename.endsWith('1612-cjs-module-globals.cjs'));
console.log('G3', path.dirname(__filename) === __dirname);
console.log('G4', path.basename(__filename));
console.log('G5', __dirname.endsWith('corpus'));
console.log('G6', fs.existsSync(__filename));
console.log('G7', fs.existsSync(path.join(__dirname, '001-hello.ts')));
console.log('G8', process.platform !== 'wasi' || process.env.PWD === process.cwd());
console.log('G9', process.platform !== 'wasi' || (process.env.HOME === '/' && fs.existsSync(process.env.HOME)));
console.log('G10', process.platform !== 'wasi' || (process.env.TMPDIR === '/tmp' && fs.existsSync(process.env.TMPDIR)));

// The alias IS the global: members lower identically through every spelling.
console.log('A1', process.platform === os.platform());
console.log('A2', process.pid === globalThis.process.pid);
console.log('A3', global.process.platform === process.platform);
console.log('A4', process.cwd().length > 0);
