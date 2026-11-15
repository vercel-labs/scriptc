// 'rejectionHandled': a handler attached after 'unhandledRejection' delivery
// fires once with the promise; the pairing is per promise, and an earlier
// handler (attached before the report) keeps the promise out of both events.
process.on('unhandledRejection', (reason, promise) => {
  console.log('unhandled', reason.message);
  if (reason.message === 'late') promise.catch(() => {});
});
process.on('rejectionHandled', (promise) => {
  console.log('handled', typeof promise);
  Promise.resolve().then(() => console.log('microtask after handled'));
});
const spared = Promise.reject(new Error('spared'));
spared.catch(() => console.log('spared caught up front'));
Promise.reject(new Error('late'));
console.log('body done');
