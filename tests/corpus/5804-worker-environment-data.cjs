'use strict';
// Environment data in CommonJS: a worker sees its parent's entries, a
// value that cannot be cloned makes new Worker() throw DataCloneError,
// and the thread keeps its own entries after that failure.
const { Worker, getEnvironmentData, isMainThread, parentPort, setEnvironmentData } = require('node:worker_threads');

if (isMainThread) {
  setEnvironmentData('greeting', 'hello');
  setEnvironmentData('list', [1, [2, 3]]);
  const worker = new Worker(__filename);
  worker.on('message', (m) => console.log('worker saw', JSON.stringify(m)));
  worker.on('exit', (code) => {
    console.log('exit', code);
    setEnvironmentData('callback', () => 1);
    try {
      new Worker(__filename);
      console.log('constructed');
    } catch (err) {
      console.log('caught', err.name);
    }
    setEnvironmentData('callback');
    console.log('kept', getEnvironmentData('greeting'), typeof getEnvironmentData('callback'));
  });
} else {
  parentPort.postMessage({ greeting: getEnvironmentData('greeting'), list: getEnvironmentData('list') });
}
