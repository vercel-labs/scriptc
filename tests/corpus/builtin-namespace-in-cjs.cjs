const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const events = require('node:events');
const stream = require('node:stream');
const util = require('node:util');
const cluster = require('node:cluster');
const KEY = 'createGzip';

function show(label, value) {
  console.log(label, value);
}

show('own', ['createGzip', 'deflateSync', 'Z_DEFAULT_COMPRESSION', 'constants'].map((k) => k in zlib));
show('absent', ['nope', 'createZstdCompressX', ''].map((k) => k in zlib));
show('inherited', ['toString', 'valueOf', 'hasOwnProperty', 'constructor', '__proto__'].map((k) => k in zlib));
show('folded-key', KEY in zlib);
show('numeric', ['0', '1', 'length'].map((k) => k in zlib));

show('fs own', ['readFileSync', 'F_OK', 'R_OK', 'constants', 'promises', 'Dirent'].map((k) => k in fs));
show('fs inherited', ['toLocaleString', 'isPrototypeOf'].map((k) => k in fs));
show('path', ['join', 'sep', 'win32', 'posix', '_makeLong', 'nope'].map((k) => k in path));

show('callable own', ['ok', 'strict', 'AssertionError', 'fail'].map((k) => k in assert));
show('callable inherited', ['call', 'apply', 'bind', 'length', 'name', 'prototype'].map((k) => k in assert));
show('callable typeof', [typeof assert, typeof events, typeof stream, typeof util]);

show('events', ['EventEmitter', 'once', 'addAbortListener', 'defaultMaxListeners', 'on'].map((k) => k in events));
show('stream', ['Readable', 'Writable', 'pipe', 'on', 'once'].map((k) => k in stream));
show('util.types', ['isPromise', 'isProxy', 'types', 'inspect', 'nope'].map((k) => k in util.types));
show('cluster', ['fork', 'isPrimary', 'on', 'emit'].map((k) => k in cluster));

show('inline require', ['createGzip', 'nope', 'toString'].map((k) => k in require('node:zlib')));
