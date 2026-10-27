'use strict';
// BroadcastChannel in JavaScript: error codes, the MessageEvent's ports,
// once and removed listeners, ref()/unref() returning the channel, and an
// unref'd channel that does not keep the process alive.
const { BroadcastChannel } = require('node:worker_threads');

for (const f of [
  () => new BroadcastChannel(),
  () => { const c = new BroadcastChannel('x'); try { c.postMessage(); } finally { c.close(); } },
  () => { const c = new BroadcastChannel('x'); c.close(); c.close(); c.postMessage(1); },
]) {
  try {
    f();
    console.log('ok');
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
}
const a = new BroadcastChannel('n');
const b = new BroadcastChannel('n');
const removed = () => console.log('removed listener ran');
b.addEventListener('message', (e) => console.log('once', e.data, Array.isArray(e.ports), e.ports.length), { once: true });
b.addEventListener('message', removed);
b.removeEventListener('message', removed);
b.onmessage = (e) => console.log('onmessage', e.data, e.target === b, this === undefined);
console.log('ref returns', a.ref() === a, a.unref() === a, b.unref() === b);
a.postMessage(1);
a.postMessage(2);
setTimeout(() => console.log('never: unref channels do not hold the loop'), 10000).unref();
setImmediate(() => console.log('immediate'));
