'use strict';
// Buffer.prototype read as a value in JavaScript, and Buffer methods read
// from an instance as values: one function per method (the "Uint" spellings
// are the "UInt" functions), called on the receiver they are given; the
// parent and offset getters; Node's own property order and enumerability.
const p = Buffer.prototype;
const buf = Buffer.from([1, 2, 3, 4]);

console.log(typeof p, p === Buffer.prototype, p.constructor === Buffer);
for (const name of ['UInt8', 'UInt16LE', 'UInt32BE', 'UIntLE', 'BigUInt64LE']) {
  const lower = name.replace(/UInt/, 'Uint');
  console.log(name, p[`read${name}`] === p[`read${lower}`], p[`write${name}`] === p[`write${lower}`]);
}
console.log(buf.indexOf === p.indexOf, buf.slice === p.slice, buf.readUInt8 === p.readUInt8);
console.log(p[`read${'UInt16LE'}`].call(buf, 0), p.toString.call(buf, 'hex'));
const write = buf.writeUInt8;
console.log(write.call(buf, 9, 3), buf);

const names = Object.getOwnPropertyNames(p);
console.log(names.length, names.slice(0, 5).join(','), names.slice(-3).join(','));
const parent = Object.getOwnPropertyDescriptor(p, 'parent');
console.log(typeof parent.get, parent.get.name, parent.enumerable, p.parent, p.offset);
console.log(Reflect.apply(parent.get, buf, []) === buf.buffer, Reflect.apply(parent.get, new Uint8Array(1), []));
const methods = Object.keys(p).filter((k) => typeof p[k] === 'function');
console.log(methods.length, methods.includes('constructor'), methods.includes('readUint8'));
