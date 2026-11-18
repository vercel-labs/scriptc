// AsyncResource exit cleanup in a worker: a store that holds its own
// resource is released at thread shutdown, which releases the resource from
// inside the cleanup walk. The walk must hold what it visits, or it writes
// to and iterates freed memory.
'use strict';
const { Worker, isMainThread } = require('worker_threads');
const { AsyncLocalStorage, AsyncResource } = require('async_hooks');

if (isMainThread) {
  const worker = new Worker(__filename);
  worker.on('exit', (code) => console.log('worker exit:', code));
} else {
  const als = new AsyncLocalStorage();
  (function build() {
    const holder = {};
    als.run(holder, () => {
      holder.resource = new AsyncResource('SELF');
    });
  })();
  console.log('worker did its work');
}
