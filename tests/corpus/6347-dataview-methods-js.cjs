'use strict';
// A DataView held in an untyped binding answers its own methods and
// Object.prototype's, and none of the typed array methods.
const view = [new DataView(new ArrayBuffer(4))][0];
function attempt(label, f) {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, `${e.name}: ${e.message}`);
  }
}
function use(v) {
  v.setUint16(0, 0x1234);
  attempt('get', () => [v.getUint16(0), v.getUint8(1)].join(' '));
  attempt('toString', () => v.toString());
  attempt('toLocaleString', () => v.toLocaleString());
  attempt('valueOf', () => v.valueOf() === v);
  attempt('join', () => v.join('-'));
  attempt('at', () => v.at(0));
  attempt('fill', () => v.fill(1));
  attempt('slice', () => v.slice(0, 1));
  attempt('indexOf', () => v.indexOf(0));
  attempt('string', () => `${String(v)} ${v}`);
}
use(view);
