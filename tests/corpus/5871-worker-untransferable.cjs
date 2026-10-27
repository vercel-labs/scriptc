'use strict';
// markAsUntransferable and isMarkedAsUntransferable: marks on objects,
// ArrayBuffers (a typed array and its ArrayBuffer are marked separately),
// functions and MessagePorts; primitives are never marked. A marked
// ArrayBuffer or port in a transfer list throws DataCloneError, and so does
// the ArrayBuffer of a pooled Buffer, which Node marks. Cloning a marked
// value is unaffected.
const { MessageChannel, isMarkedAsUntransferable, markAsUntransferable } = require('node:worker_threads');

const ab = new ArrayBuffer(8);
const before = isMarkedAsUntransferable(ab);
markAsUntransferable(ab);
console.log('arraybuffer', before, isMarkedAsUntransferable(ab));
const obj = { a: 1 };
const objectBefore = isMarkedAsUntransferable(obj);
markAsUntransferable(obj);
console.log('object', objectBefore, isMarkedAsUntransferable(obj), isMarkedAsUntransferable({ a: 1 }));
const fn = () => 1;
markAsUntransferable(fn);
console.log('function', isMarkedAsUntransferable(fn));
markAsUntransferable(5);
console.log('primitives', isMarkedAsUntransferable(5), isMarkedAsUntransferable('s'), isMarkedAsUntransferable(null), isMarkedAsUntransferable(undefined), isMarkedAsUntransferable());
const view = new Uint8Array(4);
markAsUntransferable(view.buffer);
console.log('view buffer', isMarkedAsUntransferable(view), isMarkedAsUntransferable(view.buffer));
const other = new Uint8Array(4);
markAsUntransferable(other);
console.log('view itself', isMarkedAsUntransferable(other), isMarkedAsUntransferable(other.buffer));
console.log('pooled buffer', isMarkedAsUntransferable(Buffer.from('x').buffer), isMarkedAsUntransferable(Buffer.alloc(10).buffer), isMarkedAsUntransferable(Buffer.from('x')));
const sab = new SharedArrayBuffer(4);
markAsUntransferable(sab);
console.log('shared', isMarkedAsUntransferable(sab));

const { port1, port2 } = new MessageChannel();
const spare = new MessageChannel();
markAsUntransferable(spare.port1);
console.log('port', isMarkedAsUntransferable(spare.port1), isMarkedAsUntransferable(spare.port2));
for (const [label, value] of [['marked arraybuffer', ab], ['pooled arraybuffer', Buffer.from('ab').buffer], ['marked port', spare.port1]]) {
  try {
    port1.postMessage(value, [value]);
    console.log(label, 'posted');
  } catch (e) {
    console.log(label, e.name, e.message);
  }
}
try {
  port1.postMessage('options form', { transfer: [spare.port1] });
} catch (e) {
  console.log('options form', e.name, e.message);
}
port1.postMessage({ ab, obj });
port2.on('message', (m) => {
  console.log('cloned', m.ab.byteLength, JSON.stringify(m.obj), isMarkedAsUntransferable(m.ab), isMarkedAsUntransferable(m.obj));
  port1.close();
  spare.port1.close();
});
