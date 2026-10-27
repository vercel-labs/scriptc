// Buffer's invalid-argument ladders, Node-exact: Buffer.compare /
// buf.compare / buf.equals over non-buffer values and bad offsets throw
// ERR_INVALID_ARG_TYPE / ERR_OUT_OF_RANGE with Node's argument names and
// determineSpecificType renders; undefined offset slots take their
// defaults; well-typed calls through the same checked path still compute
// real answers. Plus the deprecated `new Buffer(number, enc)` string-arm
// rejection and the ERR_* codes on the write/swap/fill range ladders.
'use strict';
// The deprecated constructor's DEP0005 report carries a process id.
process.noDeprecation = true;
const show = (fn) => {
  try {
    console.log('ret', fn());
  } catch (e) {
    console.log(`${e.name}|${e.code}|${e.message}`);
  }
};
const a = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 0]);
const b = Buffer.from([5, 6, 7, 8, 9, 0, 1, 2, 3, 4]);

// The static form's buf1/buf2 ladder (and the well-typed answer).
show(() => Buffer.compare(Buffer.alloc(1), 'abc'));
show(() => Buffer.compare('abc', Buffer.alloc(1)));
show(() => Buffer.compare(null, Buffer.alloc(1)));
show(() => Buffer.compare(a, b));

// equals: otherBuffer.
show(() => Buffer.alloc(1).equals('abc'));
show(() => Buffer.alloc(1).equals(7));
show(() => a.equals(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 0])));

// The instance ladder: target first, then each offset slot in order —
// non-numbers ERR_INVALID_ARG_TYPE, non-integers/out-of-range numbers
// ERR_OUT_OF_RANGE (Infinity renders 'an integer'), undefined defaults.
show(() => a.compare());
show(() => a.compare('abc'));
show(() => a.compare(b, '0'));
show(() => a.compare(b, undefined));
show(() => a.compare(b, 0, undefined, 0));
show(() => a.compare(b, 0, null));
show(() => a.compare(b, 0, { valueOf: () => 5 }));
show(() => a.compare(b, Infinity, -Infinity));
show(() => a.compare(b, 0xff));
show(() => a.compare(b, '0xff'));
show(() => a.compare(b, 0, '0xff'));
show(() => a.compare(b, 0, 100, 0));
show(() => a.compare(b, 0, 1, 0, 100));
show(() => a.compare(b, -1));
show(() => a.compare(b, 0, Infinity));
show(() => a.compare(b, 0, 1, -1));
show(() => a.compare(b, -Infinity, Infinity));
show(() => a.compare(b, NaN));
show(() => a.compare(b, 1.5));
show(() => a.compare(b, 6, 10));
show(() => a.compare(b, 6, 10, 0, 0));
show(() => a.compare(b, 0, 0, 0, 0));
show(() => a.compare(b, 0, 5, 4));

// new Buffer(number, encoding): the deprecated ctor's string arm.
show(() => new Buffer(42, 'utf8'));

// The write/swap/fill ladders carry their Node codes.
show(() => Buffer.alloc(9).write('foo', -1));
show(() => Buffer.alloc(9).write('foo', 10));
show(() => Buffer.from('abc').swap16());
show(() => Buffer.alloc(3).fill(Buffer.alloc(0)));
show(() => Buffer.alloc(3).writeUInt8(1, -1));
show(() => Buffer.alloc(3).writeUInt8(256, 0));
show(() => Buffer.alloc(3).writeDoubleLE(1, 1));
show(() => Buffer.alloc(1).readInt16LE(0));

// Untyped native input dispatches at runtime. Each accepted input is copied.
/** @param {unknown} value */
function fromUnknown(value) { return Buffer.from(value); }
/** @param {unknown} value */
function fromHex(value) { return Buffer.from(value, 'hex'); }
show(() => fromUnknown('hé😀').toString('hex'));
show(() => fromUnknown('').length);
show(() => fromHex('6162xx').toString('utf8'));
show(() => fromHex(new Uint8Array([65, 66])).toString('utf8'));
show(() => fromUnknown(Buffer.from('native')).toString('utf8'));
show(() => fromUnknown(JSON.parse('[257,-1,2.9,"65",true,null,{},[66],[]]')).toString('hex'));
show(() => fromUnknown(JSON.parse('{"length":3.9,"0":65,"2":67}')).toString('hex'));
show(() => fromUnknown(JSON.parse('{"length":"3","0":65}')).length);
show(() => fromUnknown(JSON.parse('{"type":"Buffer","data":[65,258,-1]}')).toString('hex'));
show(() => fromUnknown(JSON.parse('{"type":"Buffer","data":[65],"length":0}')).length);
show(() => fromUnknown({ length: -1 }).length);
show(() => fromUnknown({ length: NaN }).length);
show(() => fromUnknown({ length: Infinity }).length);
show(() => fromUnknown({ length: 1e30 }).length);
show(() => fromUnknown({ valueOf: null, length: 1, 0: 90 }).toString('hex'));
show(() => fromUnknown(null));
show(() => fromUnknown(undefined));
show(() => fromUnknown(false));
show(() => fromUnknown(42));
show(() => fromUnknown({}));
show(() => fromUnknown({ type: 'Buffer', data: 'wrong' }));

/** @param {unknown} source */
function copyInput(source) {
  const copy = Buffer.from(source);
  copy[0] = 90;
  console.log('copy', copy.toString('hex'), source[0]);
}
copyInput(new Uint8Array([65, 66]));
copyInput(JSON.parse('[65,66]'));

let coercions = '';
const element = { valueOf() { coercions += 'v'; return '67'; } };
show(() => fromUnknown([element, element]).toString('hex'));
console.log('coercions', coercions);
const badElement = { valueOf() { throw new RangeError('element failed'); } };
show(() => fromUnknown([65, badElement, 66]));

// The stream path retains Buffer flavor at the native callback boundary.
const { Readable } = require('node:stream');
const stream = new Readable({ read() { this.push('stream'); this.push(null); } });
stream.on('data', (chunk) => console.log('stream copy', fromUnknown(chunk).toString('utf8')));
const inputListener = ((chunk) => {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  console.log('input', data.toString('utf8'));
}).bind(null);
stream.on('data', inputListener);
inputListener('typed text');
