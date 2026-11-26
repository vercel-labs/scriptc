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
setTimeout(() => console.log('done'), 150);
