// Buffer.from over an untyped ArrayBuffer or SharedArrayBuffer (read from a
// Map, an untyped object field or a worker message): the Buffer covers the
// buffer from its byte offset (the second argument) and shares its memory, in
// both directions, as in Node. An encoding name or NaN in the second argument
// is offset 0; an offset past the end throws ERR_BUFFER_OUT_OF_BOUNDS.
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (isMainThread) {
  const store = new Map();
  store.set('plain', new ArrayBuffer(6));
  store.set('shared', new SharedArrayBuffer(6));
  for (const key of ['plain', 'shared']) {
    const storage = store.get(key);
    const buf = Buffer.from(storage);
    buf[1] = 0x41;
    new Uint8Array(storage)[2] = 0x42;
    console.log(key, buf.length, Buffer.isBuffer(buf), buf.toString('hex'), new Uint8Array(storage).join(','));
    const encoded = Buffer.from(storage, 'utf8');
    console.log(key, 'with encoding', encoded.length, encoded.toString('hex'));
  }

  const offsets = new Map();
  offsets.set('storage', new ArrayBuffer(8));
  const storage = offsets.get('storage');
  for (const offset of [2, 1.5, '3', NaN, null, undefined, true, 8, 9, -1, -0.5, -1.5, -1e21, -Number.MAX_VALUE, -Infinity]) {
    try {
      const view = Buffer.from(storage, offset);
      view.fill(offset === 2 ? 0x11 : 0);
      console.log('offset', String(offset), view.byteOffset, view.length, new Uint8Array(storage).join(','));
    } catch (error) {
      console.log('offset', String(offset), error.name, error.code, error.message);
    }
  }
  const sharedOffsets = new Map([['s', new SharedArrayBuffer(6)]]);
  const tail = Buffer.from(sharedOffsets.get('s'), 4);
  tail[0] = 0x7f;
  console.log('shared offset', tail.length, new Uint8Array(sharedOffsets.get('s')).join(','));

  const holder = JSON.parse('{}');
  holder.data = new ArrayBuffer(3);
  const view = Buffer.from(holder.data);
  view.write('xyz');
  console.log('field', Buffer.from(holder.data).toString());

  const sab = new SharedArrayBuffer(8);
  const worker = new Worker(__filename, { workerData: sab });
  worker.on('message', (message) => {
    const seen = Buffer.from(message.storage);
    console.log('worker wrote', seen.toString('latin1'), new Uint8Array(sab).join(','));
  });
} else {
  const out = Buffer.from(workerData);
  out.write('shared!');
  parentPort.postMessage({ storage: workerData });
}
