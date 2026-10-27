'use strict';
// Unhandled rejections are reported after the callback that left them,
// before the next due timer or the next immediate runs (Node's
// runNextTicks between macrotasks), also when several timers expire in
// the same turn.
process.on('unhandledRejection', (reason) => {
  console.log('unhandledRejection', reason instanceof Error ? reason.message : JSON.stringify(reason));
});
process.on('uncaughtException', (err, origin) => console.log(origin, err));

const start = Date.now();
setTimeout(() => void Promise.reject({ a: 1 }), 1);
setTimeout(() => void Promise.reject(new TypeError('typed reason')), 2);
setTimeout(() => {
  throw 'thrown string';
}, 3);
setTimeout(() => {
  console.log('timer 4');
  Promise.reject('handled later').catch((e) => console.log('caught', e));
}, 4);
setTimeout(() => console.log('timer 5'), 5);
// Every timer above is due once this returns.
while (Date.now() - start < 20) {}

setTimeout(() => {
  setImmediate(() => void Promise.reject('first immediate'));
  setImmediate(() => {
    console.log('second immediate');
    process.nextTick(() => console.log('tick'));
    void Promise.reject('second immediate');
  });
  setImmediate(() => console.log('third immediate'));
}, 30);
