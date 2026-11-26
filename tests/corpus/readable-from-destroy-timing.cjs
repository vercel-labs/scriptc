// Destroying a Readable.from wrapper and what happens to the stream it
// reads: Node's async iterator destroys the source on return() unless the
// readable side ENDED and the source is a half-open duplex, and a read in
// flight delays that destroy until it settles.
'use strict';

const { Readable, PassThrough, Duplex } = require('stream');

// 1. Destroyed before the source's readable side ended: the source is
// destroyed with the wrapper.
const early = new PassThrough();
const earlyWrapper = Readable.from(early);
earlyWrapper.on('data', () => {
  earlyWrapper.destroy();
});
earlyWrapper.on('close', () => console.log('early: wrapper close, source destroyed', early.destroyed));
early.write('x');

// 2. A source that reached readable EOF while its writable side is still
// open (a half-open duplex) stays alive, as Node's iterator keeps it.
const ended = new Duplex({
  allowHalfOpen: true,
  read() {
    this.push('a');
    this.push(null);
  },
  write(chunk, encoding, callback) {
    callback();
  },
});
const endedWrapper = Readable.from(ended);
endedWrapper.on('data', (chunk) => console.log('ended: data', String(chunk)));
endedWrapper.on('end', () => {
  endedWrapper.destroy();
  setTimeout(() => console.log('ended: source destroyed', ended.destroyed), 10);
});
ended.on('close', () => console.log('ended: source close'));

// 3. A read in flight delays the destroy: the iterator's return() queues
// behind the outstanding next(), so the source closes when that read
// settles, not when destroy() is called.
const slow = new Readable({
  objectMode: true,
  read() {
    setTimeout(() => {
      this.push('late');
      this.push(null);
    }, 30);
  },
});
const slowWrapper = Readable.from(slow);
slowWrapper.on('data', (chunk) => console.log('slow: data', String(chunk)));
setTimeout(() => {
  console.log('slow: destroy');
  slowWrapper.destroy();
}, 5);
slow.on('close', () => console.log('slow: source close'));
slowWrapper.on('close', () => console.log('slow: wrapper close, source destroyed', slow.destroyed));
// 4. A read in flight that completes at EOF keeps a half-open duplex's
// writable side alive: the deferred return re-checks the end state when the
// read settles (Node's finally), instead of destroying on the way in.
const late = new Duplex({
  allowHalfOpen: true,
  read() {
    setTimeout(() => this.push(null), 30);
  },
  write(chunk, encoding, callback) {
    callback();
  },
});
const lateWrapper = Readable.from(late);
lateWrapper.on('data', (chunk) => console.log('late: data', String(chunk)));
setTimeout(() => {
  console.log('late: destroy');
  lateWrapper.destroy();
}, 5);
lateWrapper.on('close', () =>
  console.log('late: wrapper close, source destroyed', late.destroyed, 'writableEnded', late.writableEnded)
);
setTimeout(() => console.log('done'), 200);
