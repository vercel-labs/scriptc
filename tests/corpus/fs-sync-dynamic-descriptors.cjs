// The fs.readSync / fs.writeSync argument ladders for calls a JavaScript
// caller leaves untyped: Node's own options forms, check order and error
// texts run at the call, and the same windows, encodings, bigint positions
// and byte views do the I/O. The helpers take their arguments as untyped
// values, which is exactly the shape the compiler cannot pin down.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = path.join(os.tmpdir(), `scr-dyn-fd-${process.pid}.txt`);
fs.writeFileSync(scratch, '0123456789');

const show = (label, fn) => {
  try {
    console.log(label, 'ret', fn());
  } catch (e) {
    console.log(label, 'err', `${e.name}|${e.code}|${e.message}`);
  }
};

// One helper per arity: Node's readSync decides its options form from the
// call's own argument count.
const read2 = (fd, buffer) => fs.readSync(fd, buffer);
const read3 = (fd, buffer, options) => fs.readSync(fd, buffer, options);
const read4 = (fd, buffer, offset, length) => fs.readSync(fd, buffer, offset, length);
const read5 = (fd, buffer, offset, length, position) =>
  fs.readSync(fd, buffer, offset, length, position);
const write2 = (fd, buffer) => fs.writeSync(fd, buffer);
const write3 = (fd, buffer, offset) => fs.writeSync(fd, buffer, offset);
const write4 = (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, length);
const write5 = (fd, buffer, offset, length, position) =>
  fs.writeSync(fd, buffer, offset, length, position);

const fd = fs.openSync(scratch, 'r+');
try {
  // ── readSync: the defaults and the options form ─────────────────────
  const defaults = Buffer.alloc(4, 46);
  console.log('read defaults', read2(fd, defaults), defaults.toString('utf8'));

  const full = Buffer.alloc(7, 46);
  console.log(
    'read options',
    read3(fd, full, { offset: 2, length: 3, position: 6 }),
    full.toString('utf8'),
  );

  const partial = Buffer.alloc(5, 46);
  console.log('read option offset', read3(fd, partial, { offset: 2 }), partial.toString('utf8'));

  const empty = Buffer.alloc(3, 46);
  console.log('read null options', read3(fd, empty, null), empty.toString('utf8'));

  // The destructuring reads offset, length and position in that order.
  const order = Buffer.alloc(4, 46);
  const orderOptions = {
    get offset() {
      console.log('read get offset');
      return 1;
    },
    get length() {
      console.log('read get length');
      return 2;
    },
    get position() {
      console.log('read get position');
      return 4;
    },
  };
  console.log('read member order', read3(fd, order, orderOptions), order.toString('utf8'));

  // In the three argument form anything non-object lands in the options
  // slot and takes validateObject's error.
  show('read number options', () => read3(fd, Buffer.alloc(2), 1));
  show('read string options', () => read3(fd, Buffer.alloc(2), 'r'));

  // ── readSync: positions ─────────────────────────────────────────────
  const big = Buffer.alloc(2, 46);
  console.log('read bigint position', read5(fd, big, 0, 2, 8n), big.toString('utf8'));
  show('read bigint -1', () => read5(fd, Buffer.alloc(2), 0, 2, -1n));
  show('read bigint huge', () => read5(fd, Buffer.alloc(2), 0, 2, 10n ** 20n));
  show('read position string', () => read5(fd, Buffer.alloc(2), 0, 2, '2'));
  show('read position fraction', () => read5(fd, Buffer.alloc(2), 0, 2, 1.5));
  show('read position NaN', () => read5(fd, Buffer.alloc(2), 0, 2, NaN));
  show('read position negative', () => read5(fd, Buffer.alloc(2), 0, 2, -2));

  // ── readSync: length and window ─────────────────────────────────────
  const coerced = Buffer.alloc(4, 46);
  console.log('read string length', read4(fd, coerced, 0, '3'), coerced.toString('utf8'));
  show('read null length', () => read4(fd, Buffer.alloc(4), 0, null));
  show('read negative length', () => read4(fd, Buffer.alloc(4), 0, -1));
  show('read window', () => read4(fd, Buffer.alloc(4), 2, 100));
  show('read fraction length', () => read4(fd, Buffer.alloc(4), 0, 1.5));
  show('read offset fraction', () => read4(fd, Buffer.alloc(4), 0.5, 1));

  // The options form's length default subtracts the raw offset value, so a
  // Symbol or a BigInt there throws its conversion error before the offset
  // is validated; the classic form's `length |= 0` turns undefined into 0.
  show('read undefined length', () => read4(fd, Buffer.alloc(4), 0, undefined));
  show('read options symbol offset', () => read3(fd, Buffer.alloc(2), { offset: Symbol('x') }));
  show('read options bigint offset', () => read3(fd, Buffer.alloc(2), { offset: 1n }));
  show('read bigint length', () => read4(fd, Buffer.alloc(4), 0, 1n));

  show('read empty buffer', () => read4(fd, Buffer.alloc(0), 0, 1));
  show('read empty view', () => read4(fd, new Uint8Array(0), 0, 1));
  show('read bad buffer', () => read2(fd, {}));
  show('read string buffer', () => read2(fd, 'abc'));

  // ── readSync: views other than Uint8Array ───────────────────────────
  const words = new Uint16Array(2);
  console.log('read uint16', read5(fd, words, 0, 4, 0), words[0], words[1]);
  const view = new DataView(new ArrayBuffer(3));
  console.log('read dataview', read5(fd, view, 0, 3, 2), view.getUint8(0), view.getUint8(2));

  // ── readSync: the descriptor is checked last ────────────────────────
  show('read bad fd after offset', () => read5('x', Buffer.alloc(2), 0.5, 1, 0));
  show('read bad fd', () => read5('x', Buffer.alloc(2), 0, 1, 0));
  show('read negative fd', () => read5(-1, Buffer.alloc(2), 0, 1, 0));

  // ── writeSync: the view form ────────────────────────────────────────
  console.log('write defaults', write2(fd, Buffer.from('AB')));
  console.log(
    'write options',
    write3(fd, Buffer.from('WXYZ'), { offset: 1, length: 2, position: 7 }),
  );
  console.log('write offset', write3(fd, Buffer.from('cdef'), 2));
  console.log('write length default', write4(fd, Buffer.from('QRST'), 1, '3'));
  console.log(
    'write member order',
    write3(fd, Buffer.from('mnop'), {
      get offset() {
        console.log('write get offset');
        return 1;
      },
      get length() {
        console.log('write get length');
        return 2;
      },
      get position() {
        console.log('write get position');
        return 3;
      },
    }),
  );
  show('write null options', () => write3(fd, Buffer.from('uv'), null));
  show('write offset fraction', () => write3(fd, Buffer.from('w'), 0.5));
  show('write offset past end', () => write3(fd, Buffer.from('w'), 99));
  show('write length past end', () => write4(fd, Buffer.from('w'), 1, 99));
  show('write negative length', () => write4(fd, Buffer.from('w'), 0, -1));
  show('write fraction length', () => write4(fd, Buffer.from('w'), 0, 1.5));
  show('write bigint length', () => write4(fd, Buffer.from('w'), 0, 1n));

  const wide = new Uint16Array([0x4241]);
  console.log('write uint16', write5(fd, wide, 0, 2, 0));

  // ── writeSync: the string form and its encodings ────────────────────
  console.log('write string', write2(fd, 'a'));
  console.log('write string position', write3(fd, 'b', 4));
  console.log('write string null position', write4(fd, 'c', null, 'utf8'));
  console.log('write hex', write4(fd, 'zZ', 0, 'hex'));
  show('write hex odd', () => write4(fd, 'abc', 0, 'hex'));
  show('write hex odd upper', () => write4(fd, 'abc', 0, 'HEX'));
  console.log('write unknown encoding', write4(fd, 'x', 0, 'bogus'));
  console.log('write non-string encoding', write4(fd, 'y', 0, 5));
  console.log('write utf16le', write4(fd, 'hi', 0, 'utf16le'));
  console.log('write base64', write4(fd, 'aGk=', 0, 'base64'));
  console.log('write latin1', write4(fd, 'é', 0, 'latin1'));
  show('write number buffer', () => write2(fd, 5));
  show('write object buffer', () => write2(fd, {}));
  show('write bad fd', () => write2('x', 'abc'));
  show('write huge fd', () => write2(2147483648, 'abc'));
  show('write closed fd', () => {
    const closed = fs.openSync(scratch, 'r');
    fs.closeSync(closed);
    return write2(closed, Buffer.from('k'));
  });
} finally {
  fs.closeSync(fd);
}
console.log('bytes', fs.readFileSync(scratch).toString('hex'));
fs.unlinkSync(scratch);
