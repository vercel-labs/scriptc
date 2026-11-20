// A Microtask runs inside the resource's execution scope: its before and
// after hooks see the resource's id, and the store a queueMicrotask call
// captured is visible to both hooks. Its destroy is emitted after the next
// ticks and microtasks queued later in the same turn have run, as Node's
// destroy phase follows its checkpoint. Only the three microtasks this
// program schedules are observed: the module host schedules its own
// resources, whose hook traffic is not part of the claim.
'use strict';
const { createHook, executionAsyncId, AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const order = [];
const microIds = new Set();
const scoped = [];
const stores = {};
let lastMicrotask = 0;

const hook = createHook({
  init(id, type) {
    if (type === 'Microtask') lastMicrotask = id;
  },
  before(id) {
    if (!microIds.has(id)) return;
    scoped.push(id === executionAsyncId());
    stores[id] = [als.getStore()];
  },
  after(id) {
    if (!microIds.has(id)) return;
    scoped.push(id === executionAsyncId());
    stores[id].push(als.getStore());
  },
  destroy(id) {
    if (microIds.has(id)) order.push('micro-destroy');
  },
});
hook.enable();

queueMicrotask(() => order.push('first'));
const firstId = lastMicrotask;
microIds.add(firstId);

queueMicrotask(() => process.nextTick(() => order.push('tick')));
const secondId = lastMicrotask;
microIds.add(secondId);

als.run('scheduled', () => queueMicrotask(() => order.push('stored')));
const storedId = lastMicrotask;
microIds.add(storedId);

// An enterWith inside the callback is discarded before the after hook, so
// the hook sees the store the call captured, as in Node.
als.run('outer', () => queueMicrotask(() => als.enterWith('replacement')));
const enterId = lastMicrotask;
microIds.add(enterId);

setImmediate(() => {
  console.log('hooks in the resource scope:', scoped.length, scoped.every(Boolean));
  console.log(
    'stores:',
    JSON.stringify([firstId, secondId, storedId, enterId].map((id) => stores[id])),
  );
  console.log(
    'destroy after the later tick:',
    order.indexOf('micro-destroy') > order.indexOf('tick'),
  );
  hook.disable();
});
