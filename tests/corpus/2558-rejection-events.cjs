// The rejection-event family: process.once('unhandledRejection') auto-
// removes after one delivery, off/removeListener remove by identity, and
// 'rejectionHandled' fires when a handler attaches to a rejection the
// report already delivered. This fixture attaches the .catch inside the
// unhandledRejection listener, exactly Node's late-handling shape. The
// compiled runtime dispatches at the completed checkpoint, listener order
// included.
'use strict';

process.once('unhandledRejection', (err) => {
  console.log('once:', err.message);
});

process.on('unhandledRejection', (err, promise) => {
  console.log('on:', err.message);
  if (err.message === 'last') {
    console.log('attaching late handler');
    promise.catch(() => {});
  }
});

const removed = () => {
  console.log('removed listener must never fire');
};
process.on('unhandledRejection', removed);
process.off('unhandledRejection', removed);

process.on('rejectionHandled', (promise) => {
  console.log('rejectionHandled:', typeof promise === 'object');
});

Promise.reject(new Error('first'));
Promise.reject(new Error('last'));
console.log('sync tail');
