'use strict';
// Buffer methods with arguments JavaScript passes as other values, and
// Buffer.prototype methods called on a plain Uint8Array, as Node's
// test/parallel buffer files call them. Offsets convert with toInteger
// (strings, objects through Symbol.toPrimitive, valueOf or toString), and
// toString's encoding converts with ToString. On a Uint8Array receiver the
// methods run as they do on a Buffer: fill answers the receiver, slice is
// the receiver's subarray (a Uint8Array), and subarray makes a Buffer.
// copy copies bytes between any ArrayBufferViews, and inspect renders the
// receiver's constructor name and its first 50 bytes.
import assert from 'node:assert';

function show(label, fn) {
  try {
    console.log(label, fn());
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}

const b = Buffer.from('0123456789');
const c = Buffer.alloc(10);
show('copy strings', () => [b.copy(c, '0', '2', '5'), c.toString('latin1', 0, 3)]);
show('copy invalid offset', () => b.copy(c, 'not a valid offset'));
show('copy toPrimitive', () => b.copy(c, { [Symbol.toPrimitive]: () => 4 }));
show('copy throwing toPrimitive', () => b.copy(c, { [Symbol.toPrimitive]() { throw new Error('foo'); } }));
show('toString strings', () => b.toString('ascii', '2', '5'));
show('toString Infinity', () => JSON.stringify(b.toString('ascii', 'Infinity', 3)));
show('toString object encoding', () => b.toString({ toString: () => 'hex' }, 0, 2));
show('slice strings', () => b.slice('2', '5'));
show('slice foobar', () => b.slice('foobar').length);
show('subarray string', () => b.subarray('7'));

const { copy, fill, slice, subarray, toString, toLocaleString, inspect } = Buffer.prototype;
const u8 = Uint8Array.of(1, 2, 3, 4, 5, 6);
show('toString.call', () => toString.call(u8, 'hex'));
show('fill.call answers the receiver', () => {
  const view = new Uint8Array(4);
  const out = fill.call(view, 'ab');
  return [out === view, Buffer.isBuffer(view), view];
});
show('slice.call', () => {
  const s = slice.call(u8, 1, 3);
  return [s.constructor.name, Buffer.isBuffer(s), s];
});
show('subarray.call', () => Buffer.isBuffer(subarray.call(u8, 1, 3)));
show('copy.call', () => {
  const target = new Uint8Array(4);
  return [copy.call(u8, target, 1, 3), target];
});
show('copy.call non-view', () => copy.call(0));
show('copy into Uint16Array', () => {
  const x = new Uint16Array(4);
  const copied = Buffer.of(1, 2, 3, 4).copy(x);
  return [copied, Array.from(new Uint8Array(x.buffer, 0, 8))];
});
const custom = Symbol.for('nodejs.util.inspect.custom');
console.log(toLocaleString === toString, Buffer.prototype[custom] === inspect);
console.log(inspect.call(u8), inspect.call(new Uint8Array(0)), Buffer.alloc(60)[custom]());

const unknownBytes = subarray.call(u8, 2, 5);
assert.deepStrictEqual(unknownBytes, Buffer.from([3, 4, 5]));
show('deep against a Uint8Array', () => assert.deepStrictEqual(unknownBytes, new Uint8Array([3, 4, 5])));
assert.notDeepStrictEqual(unknownBytes, new Uint8Array([3, 4, 5]));
console.log('done');
