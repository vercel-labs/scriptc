// @exit: 3
'use strict';
// process.exit(code) assigns process.exitCode first: a code that is not a
// safe integer throws a RangeError and execution continues. Valid codes
// convert to int32, which a worker's 'exit' event reports in full. An
// 'uncaughtException' listener receives an unhandled rejection with origin
// 'unhandledRejection': an Error reason as itself, any other reason as
// Node's UnhandledPromiseRejection Error quoting the reason.
const { Worker, isMainThread, workerData } = require('node:worker_threads');

const codes = [1.5, -1, 261, 2 ** 32 + 5];

if (isMainThread) {
  process.on('uncaughtException', (err, origin) => {
    const at = typeof err.message === 'string' ? err.message.indexOf('The promise') : -1;
    console.log(origin, err instanceof Error, err.name, err.code, at < 0 ? err.message : err.message.slice(at));
    console.log(' ', JSON.stringify(err), typeof err === 'object' ? Object.keys(err).join(',') : typeof err);
  });
  for (const code of [3.7, 2 ** 53, NaN]) {
    try {
      process.exit(code);
    } catch (error) {
      if (error instanceof RangeError) console.log(error.name, error.message);
    }
  }
  void Promise.reject('main reason');
  setTimeout(() => void Promise.reject({ a: 1 }), 1);
  setTimeout(() => void Promise.reject(new TypeError('typed reason')), 2);
  setTimeout(() => {
    throw 'thrown string';
  }, 3);
  let next = 0;
  const run = () => {
    const code = codes[next++];
    if (code === undefined) process.exit(256 + 3);
    const worker = new Worker(__filename, { workerData: code });
    worker.on('error', (e) => console.log(code, 'error', e.name, e.code));
    worker.on('exit', (exitCode) => {
      console.log(code, 'exit', exitCode);
      run();
    });
  };
  setTimeout(run, 20);
} else {
  process.exit(workerData);
}
