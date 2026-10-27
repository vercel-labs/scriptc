'use strict';
// worker.stdout as a pipe source: with only the stdout option, the
// worker's stdout writes reach the parent's Writable while its stderr
// output goes to the process's stderr as before.
const { Worker, isMainThread } = require('node:worker_threads');
const { Writable } = require('node:stream');

if (isMainThread) {
  const worker = new Worker(__filename, { stdout: true });
  const chunks = [];
  const sink = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString().toUpperCase());
      callback();
    },
  });
  sink.on('finish', () => console.log('piped', JSON.stringify(chunks.join(''))));
  worker.stdout.pipe(sink);
  worker.on('exit', (code) => console.log('exit', code));
} else {
  console.log('first line');
  console.error('to stderr');
  console.log('second line');
}
