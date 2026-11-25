// Element reads of typed arrays in a JavaScript source compared with each
// other, in range and past the end: two reads past the end both answer
// undefined and compare equal, and a read past the end of a `number[]`
// compared with one of a typed array does too.
'use strict';

const bytes = new Uint8Array([10, 20, 30, 40]);
const view = new Uint8Array(bytes.buffer);
console.log(bytes[0] === view[0], bytes[9] === view[9], bytes[1] !== view[2]);

for (const step of [1, 2]) {
  const alias = new Uint8Array(bytes.buffer);
  const before = bytes[0];
  alias[0] = before + step;
  console.log(bytes[0] === alias[0], bytes[0]);
}

const numbers = [1, 2, 3];
const ints = new Int32Array([1, 2, 3]);
console.log(numbers[0] === ints[0], numbers[7] === ints[7], numbers[7] === numbers[8]);
console.log(numbers[1] + ints[1], numbers[7] + ints[7], ints[7] | 0);
