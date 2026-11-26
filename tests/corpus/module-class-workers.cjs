'use strict';
// node:module's Module class in workers: every thread's CommonJS module is an
// instance of the Module export, including a worker that reads the class
// after the main thread already did.
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const { Module } = require('node:module');

function describe() {
  const prototype = Object.getPrototypeOf(module);
  return [
    Module.name,
    Module.length,
    module instanceof Module,
    prototype === Module.prototype,
    prototype.constructor === Module,
    typeof prototype.require,
    typeof prototype.load,
  ].join(' ');
}

if (isMainThread) {
  console.log('main', describe());
  const worker = new Worker(__filename);
  worker.on('message', (text) => console.log('worker', text));
  worker.on('exit', (code) => console.log('exit', code));
} else {
  console.log('thread', describe());
  parentPort.postMessage(typeof Module + ' ' + (module instanceof Module));
}
