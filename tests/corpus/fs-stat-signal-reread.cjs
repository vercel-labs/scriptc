// fs.stat's options.signal is read three times: getOptions' presence test,
// validateAbortSignal, and checkAborted. A getter may answer a different
// value on that last read, and checkAborted reads `aborted` and `reason`
// as ordinary JavaScript properties: an array or a number is not an aborted
// signal, a plain object whose `aborted` is true is. None of them is a
// native AbortSignal handle, and the call answers them without crashing.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-signal-reread-'));
const file = path.join(dir, 'f.txt');
fs.writeFileSync(file, 'abc');

const controller = new AbortController();
controller.abort('first');

// The first two reads answer the validated signal; every later read answers
// `later`, the value checkAborted sees.
const stateful = (later) => {
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'signal', {
    enumerable: true,
    get() {
      reads += 1;
      return reads <= 2 ? controller.signal : later;
    },
  });
  return options;
};

const show = (label, value) => {
  console.log(label, value.name, value.code, JSON.stringify(value.message));
};

const steps = [
  (next) =>
    fs.stat(file, stateful([1, 2]), (err, stats) => {
      console.log('array reread', err, typeof stats.size, stats.isFile());
      next();
    }),
  (next) =>
    fs.stat(file, stateful(7), (err, stats) => {
      console.log('number reread', err, typeof stats.size);
      next();
    }),
  (next) =>
    fs.stat(file, stateful(null), (err, stats) => {
      console.log('null reread', err, typeof stats.size);
      next();
    }),
  (next) => {
    const reason = new Error('plain cause');
    let called = 'not called';
    const answered = fs.stat(file, stateful({ aborted: true, reason }), (err, stats) => {
      called = `${err.name}|${err.code}|${err.message}|${err.cause && err.cause.message}|${stats}`;
    });
    console.log('object reread synchronous', called, answered);
    next();
  },
  (next) => {
    // The stat completes later: the next step, which removes the
    // directory, waits for its callback.
    let called = 'not called';
    const answered = fs.stat(file, stateful({ aborted: false }), (err, stats) => {
      called = `${err}|${typeof stats.size}`;
      console.log('false aborted completes', called);
      next();
    });
    console.log('false aborted continues', called, answered);
  },
];

const runStep = (at) => {
  if (at === steps.length) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  steps[at](() => runStep(at + 1));
};
runStep(0);
