// Atomics over untyped arrays in JavaScript: a worker's workerData carries
// Int32Array and Uint8Array views of a SharedArrayBuffer, and load, store,
// add, sub, and, or, xor, exchange, compareExchange, wait and notify run on
// them as on typed bindings. Other values throw Node's
// TypeError, and an index outside the array Node's RangeError. The results
// go to an untyped array.
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const lines = [];
function attempt(label, run) {
  try {
    run();
    lines.push(`${label} ok`);
  } catch (error) {
    lines.push(`${label} ${error.name} ${error.message}`);
  }
}

if (isMainThread) {
  const sab = new SharedArrayBuffer(16);
  const counters = new Int32Array(sab);
  const worker = new Worker(__filename, { workerData: { counters, bytes: new Uint8Array(sab, 8, 8) } });
  worker.on('message', (message) => {
    if (message === 'ready') {
      Atomics.store(counters, 1, 42);
      console.log('notified', Atomics.notify(counters, 1, 1) >= 0);
      return;
    }
    for (const line of message.lines) console.log(line);
    console.log('worker results', JSON.stringify(message.out));
    console.log('counters', Array.from(counters).join(','));
  });
} else {
  const counters = workerData.counters;
  const bytes = workerData.bytes;
  const out = [];
  out.push(Atomics.add(counters, 0, 5), Atomics.sub(counters, 0, 2), Atomics.load(counters, 0));
  out.push(Atomics.or(counters, 2, 6), Atomics.and(counters, 2, 3), Atomics.xor(counters, 2, 1), Atomics.load(counters, 2));
  out.push(Atomics.exchange(counters, 3, 9), Atomics.compareExchange(counters, 3, 9, 11), Atomics.compareExchange(counters, 3, 0, 1));
  out.push(Atomics.add(bytes, 0, 300), Atomics.load(bytes, 0), Atomics.sub(bytes, 1, 1), Atomics.load(bytes, 1));
  out.push(Atomics.load(counters, 1.9), Atomics.load(counters, NaN));
  attempt('index past the end', () => {
    Atomics.load(counters, 4);
  });
  attempt('negative index', () => {
    Atomics.add(bytes, -1, 1);
  });
  const values = [[], {}, undefined, null, 5, 'text', new Float64Array(2), new Map(), new ArrayBuffer(4), new DataView(new ArrayBuffer(4))];
  for (const value of values) {
    attempt('load', () => {
      Atomics.load(value, 0);
    });
    attempt('notify', () => {
      Atomics.notify(value, 0);
    });
  }
  attempt('wait on Uint8Array', () => {
    Atomics.wait(bytes, 0, 0, 0);
  });
  out.push(Atomics.wait(counters, 1, 0, 0));
  parentPort.postMessage('ready');
  out.push(Atomics.wait(counters, 1, 0, 5000) === 'ok' || Atomics.load(counters, 1) === 42);
  parentPort.postMessage({ out, lines });
}
