'use strict';
// Detached and empty views in the descriptor I/O calls: a detached DataView
// takes Node's catchable byteLength TypeError from readSync/writeSync, a
// detached typed array counts as an empty view, and the vector calls count
// either as a zero-byte element instead of aborting the process.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = path.join(os.tmpdir(), `scr-detached-${process.pid}.txt`);
const fd = fs.openSync(scratch, 'w+');
fs.writeSync(fd, Buffer.from('0123456789'));

const show = (label, fn) => {
  try {
    console.log(label, 'ret', fn());
  } catch (e) {
    console.log(label, 'err', `${e.name}|${e.code}|${e.message}`);
  }
};

const detached = (kind) => {
  const ab = new ArrayBuffer(8);
  const view = kind === 'DataView' ? new DataView(ab)
    : kind === 'Uint8Array' ? new Uint8Array(ab) : new Int32Array(ab);
  ab.transfer();
  return view;
};

// A fixed-length view of a resizable buffer is out of bounds after a shrink.
const shrunk = (kind) => {
  const ab = new ArrayBuffer(16, { maxByteLength: 16 });
  const view = kind === 'DataView' ? new DataView(ab, 0, 16) : new Int32Array(ab, 0, 4);
  ab.resize(8);
  return view;
};

// The callers are untyped, so each call takes the run-time argument ladder.
const write = (fd, buffer, offset, length, position) =>
  fs.writeSync(fd, buffer, offset, length, position);
const writeDefault = (fd, buffer) => fs.writeSync(fd, buffer);
const read = (fd, buffer, offset, length, position) =>
  fs.readSync(fd, buffer, offset, length, position);
const readDefault = (fd, buffer) => fs.readSync(fd, buffer);
const writev = (fd, buffers, position) => fs.writevSync(fd, buffers, position);
const readv = (fd, buffers, position) => fs.readvSync(fd, buffers, position);

// A detached DataView's byteLength getter throws where Node reads it.
show('write view', () => write(fd, detached('DataView'), 0, 4, 0));
show('write view default length', () => writeDefault(fd, detached('DataView')));
show('read view', () => read(fd, detached('DataView'), 0, 4, 0));
show('read view default length', () => readDefault(fd, detached('DataView')));

// A detached typed array reads as an empty view.
show('write words', () => write(fd, detached('Int32Array'), 0, 4, 0));
show('write words default length', () => writeDefault(fd, detached('Int32Array')));
show('read words', () => read(fd, detached('Int32Array'), 0, 4, 0));
show('read words zero length', () => read(fd, detached('Int32Array'), 0, 0, 0));
show('write bytes', () => writeDefault(fd, detached('Uint8Array')));
show('read bytes', () => read(fd, detached('Uint8Array'), 0, 4, 0));

// The same answers for a fixed-length view of a buffer shrunk past it.
show('write shrunk view', () => write(fd, shrunk('DataView'), 0, 4, 0));
show('read shrunk view', () => readDefault(fd, shrunk('DataView')));
show('write shrunk words', () => write(fd, shrunk('Int32Array'), 0, 4, 0));
show('writev shrunk', () => writev(fd, [shrunk('DataView')], 0));

// A vector element that cannot be viewed counts as zero bytes.
show('writev view', () => writev(fd, [detached('DataView')], 0));
show('readv view', () => readv(fd, [detached('DataView')], 0));
show('writev words', () => writev(fd, [detached('Int32Array')], 0));
show('readv words', () => readv(fd, [detached('Int32Array')], 0));
show('writev mixed', () => writev(fd, [Buffer.from('ab'), detached('DataView')], 0));
show('readv mixed', () => readv(fd, [Buffer.alloc(2), detached('DataView')], 0));
show('writev after errors', () => writev(fd, [Buffer.from('CD')], 2));

console.log('contents', fs.readFileSync(scratch, 'utf8'));
fs.closeSync(fd);
fs.rmSync(scratch, { force: true });
