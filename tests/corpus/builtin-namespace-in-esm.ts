import * as zlib from 'node:zlib';
import * as path from 'node:path';
import * as assert from 'node:assert';
import * as events from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const zlibCjs = require('node:zlib');

console.log('esm own', ['createGzip', 'deflateSync', 'constants', 'crc32', 'nope'].map((k) => k in zlib));
console.log('esm prototype', ['toString', 'valueOf', 'hasOwnProperty', 'constructor'].map((k) => k in zlib));
console.log('esm default', 'default' in zlib, 'default' in path);
console.log('esm path', ['join', 'sep', 'win32', 'nope'].map((k) => k in path));
console.log('esm callable', ['ok', 'strict', 'call', 'apply', 'length'].map((k) => k in assert));
console.log('esm events', ['EventEmitter', 'once', 'on'].map((k) => k in events));
console.log('esm typeof', [typeof zlib, typeof assert, typeof events, typeof path]);
console.log('esm keys', Object.keys(zlib).join(','));
console.log('esm keys path', Object.keys(path).join(','));

const alias = zlib;
console.log('alias', 'createGzip' in alias, 'toString' in alias, Object.keys(alias).length);

console.log('cjs own', ['createGzip', 'nope', 'toString'].map((k) => k in zlibCjs));
console.log('cjs keys', Object.keys(zlibCjs).join(','));

// A runtime key over an awaited dynamic import: Node reads the key before
// the import runs, so the key is held in a local first.
const runtimeNames = ['deflateSync', 'nope', 'toString'];
for (const k of runtimeNames) console.log('esm runtime', k, k in (await import('node:zlib')));
