// fs.writeFile reads options.signal three times: twice in getOptions (the
// presence test and validateAbortSignal), then again in checkAborted. A
// getter may answer a different value on that last read, and checkAborted
// reads `aborted` and `reason` as ordinary JavaScript properties: an array,
// a number or null is not an aborted signal, a plain object whose `aborted`
// is true is. None of the last-read values is a native AbortSignal handle,
// and the call answers them without crashing.
//
// fs.appendFile copies its normalized options before delegating to
// writeFile, so the copy is what writeFile validates; its getter's last read
// must therefore still answer a real AbortSignal, and the aborted and
// non-aborted cases below cover that path.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-signal-reread-'));
const file = path.join(dir, 'f.txt');
fs.writeFileSync(file, '');

const first = new AbortController();
first.abort('first');
const halted = new AbortController();
halted.abort('halted');
const open = new AbortController();

// The first two reads answer the validated signal; every later read answers
// `later`, the value checkAborted sees.
const stateful = (later) => {
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'signal', {
    enumerable: true,
    get() {
      reads += 1;
      return reads <= 2 ? first.signal : later;
    },
  });
  return options;
};

const shown = (error) => (error ? `${error.name}|${error.code}|${error.message}` : 'null');

const steps = [
  (next) =>
    fs.writeFile(file, 'one', stateful([1, 2]), (err) => {
      console.log('array reread', shown(err), fs.readFileSync(file, 'utf8'));
      next();
    }),
  (next) =>
    fs.writeFile(file, 'two', stateful(7), (err) => {
      console.log('number reread', shown(err), fs.readFileSync(file, 'utf8'));
      next();
    }),
  (next) =>
    fs.writeFile(file, 'three', stateful(null), (err) => {
      console.log('null reread', shown(err), fs.readFileSync(file, 'utf8'));
      next();
    }),
  (next) => {
    const reason = new Error('plain cause');
    let called = 'not called';
    const answered = fs.writeFile(file, 'never', stateful({ aborted: true, reason }), (err) => {
      called = `${err.name}|${err.code}|${err.message}|${err.cause && err.cause.message}`;
    });
    console.log('object reread synchronous', called, answered, fs.readFileSync(file, 'utf8'));
    next();
  },
  (next) => {
    let called = 'not called';
    const answered = fs.appendFile(file, 'never', stateful(halted.signal), (err) => {
      called = `${err.name}|${err.code}|${err.message}|${err.cause && err.cause.message}`;
    });
    console.log('append aborted synchronous', called, answered, fs.readFileSync(file, 'utf8'));
    next();
  },
  (next) =>
    fs.appendFile(file, 'appended', stateful(open.signal), (err) => {
      console.log('append open', shown(err), fs.readFileSync(file, 'utf8'));
      next();
    }),
];

const runStep = (at) => {
  if (at === steps.length) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  steps[at](() => runStep(at + 1));
};
runStep(0);
