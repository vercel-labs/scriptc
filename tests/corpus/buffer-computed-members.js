'use strict';
// Buffer methods read with keys computed at run time, as Node's
// test/parallel buffer files call them: buf[`read${name}`](...). The
// fixed-width, variable-width and BigInt families run with Node's
// argument checks; parent and offset answer the backing ArrayBuffer and
// byteOffset on a Buffer and undefined on a Uint8Array.

function show(label, fn) {
  try {
    console.log(label, fn());
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}

const buf = Buffer.alloc(10);
for (const name of ['UInt8', 'Uint16LE', 'Int32BE', 'FloatLE', 'DoubleBE']) {
  const write = buf[`write${name}`];
  const read = buf[`read${name}`];
  console.log(name, typeof write, typeof read, read.length);
  show(`write${name}`, () => buf[`write${name}`](1, 0));
  show(`read${name}`, () => buf[`read${name}`](0));
}

for (const name of ['UIntLE', 'UIntBE', 'IntLE', 'IntBE']) {
  show(`write${name} 6`, () => buf[`write${name}`](-1 >>> 1, 2, 6));
  show(`read${name} 6`, () => buf[`read${name}`](2, 6));
  show(`read${name} 3`, () => buf[`read${name}`](1, 3));
  show(`read${name} no offset`, () => buf[`read${name}`]());
  show(`read${name} byteLength 7`, () => buf[`read${name}`](0, 7));
  show(`read${name} byteLength 1.5`, () => buf[`read${name}`](0, 1.5));
  show(`read${name} byteLength '2'`, () => buf[`read${name}`](0, '2'));
  show(`read${name} offset '1'`, () => buf[`read${name}`]('1', 2));
  show(`read${name} offset 9`, () => buf[`read${name}`](9, 2));
  show(`write${name} big value`, () => buf[`write${name}`](2 ** 48, 0, 6));
  show(`write${name} value 2 ** 40, width 5`, () => buf[`write${name}`](2 ** 40, 0, 5));
  show(`write${name} bad offset after value`, () => buf[`write${name}`](1, 'x', 2));
}

for (const name of ['BigInt64LE', 'BigInt64BE', 'BigUInt64LE', 'BigUint64BE']) {
  show(`write${name}`, () => buf[`write${name}`](-123456789n, 1));
  show(`read${name}`, () => buf[`read${name}`](1));
  show(`read${name} default offset`, () => buf[`read${name}`]());
  show(`read${name} offset 3`, () => buf[`read${name}`](3));
  show(`write${name} 2n ** 64n`, () => buf[`write${name}`](2n ** 64n));
  show(`write${name} -1000n`, () => buf[`write${name}`](-1000n));
  show(`write${name} number in range`, () => buf[`write${name}`](5, 0));
  show(`write${name} number out of range`, () => buf[`write${name}`](2 ** 70, 0));
  show(`write${name} string out of range`, () => buf[`write${name}`]('99999999999999999999999', 0));
  show(`write${name} 'bad'`, () => buf[`write${name}`]('bad', 0));
  show(`write${name} bad offset`, () => buf[`write${name}`](1n, '1'));
}

const key = 'indexOf';
console.log(buf[key] === Buffer.prototype.indexOf, typeof buf['nope' + key]);
console.log(buf.parent === buf.buffer, buf.offset === buf.byteOffset);
const view = new Uint8Array(4);
console.log(view.parent, view.offset, typeof view['read' + 'UInt8']);
