'use strict';
// Buffer.of builds a Buffer outside the pool, converting each item as an
// element assignment does; JSON.stringify serializes a Buffer through its
// toJSON ({ type: 'Buffer', data }) and another typed array by index.
const made = Buffer.of(1, 2, 258, 1.9, -1);
console.log(made, Buffer.isBuffer(made), made.buffer.byteLength, made.byteOffset);
console.log(Buffer.of().length, Buffer.of(255).toString('hex'));

const buf = Buffer.from([1, 2, 3]);
const view = new Uint8Array([4, 5]);
console.log(JSON.stringify(buf), JSON.stringify(Buffer.alloc(0)), JSON.stringify(view));
console.log(JSON.stringify({ b: buf, n: 1 }));
console.log(JSON.stringify(buf, null, 2));
const copy = Buffer.from(JSON.parse(JSON.stringify(Buffer.from('test'))));
console.log(copy, copy.toString());
