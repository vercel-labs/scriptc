// Destructuring the members of a worker's workerData in JavaScript: plain,
// renamed, defaulted, nested and rest bindings read the data the worker was
// started with, as reading `workerData.<member>` does.
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (isMainThread) {
  const sab = new SharedArrayBuffer(8);
  const data = { name: 'job-7', size: 3, options: { verbose: true, tags: ['a', 'b'] }, counters: new Int32Array(sab), extra: 1, more: 'x' };
  const worker = new Worker(__filename, { workerData: data });
  worker.on('message', (lines) => {
    for (const line of lines) console.log(line);
    console.log('main sees', new Int32Array(sab)[0]);
  });
} else {
  const lines = [];
  const { name, size } = workerData;
  lines.push(`plain ${name} ${size}`);
  const { name: jobName, missing = 'fallback', size: count = 10 } = workerData;
  lines.push(`renamed ${jobName} ${missing} ${count}`);
  const {
    options: { verbose, tags: [firstTag, ...otherTags] },
  } = workerData;
  lines.push(`nested ${verbose} ${firstTag} ${JSON.stringify(otherTags)}`);
  const { name: ignored, size: alsoIgnored, options, counters, ...rest } = workerData;
  lines.push(`rest ${JSON.stringify(rest)} ${typeof options} ${ignored === name && alsoIgnored === size}`);
  counters[0] = 41;
  counters[0] += 1;
  parentPort.postMessage(lines);
}
