// queueMicrotask runs as Node's 'Microtask' async resource while async hooks
// are in use: init at scheduling with the scheduling execution as its trigger,
// before/after around the callback, the resource's id as the execution id
// inside it, and destroy from a later iteration.
'use strict';
const { createHook, executionAsyncId } = require('async_hooks');

const events = [];
let microId;
const hook = createHook({
  init(id, type, trigger) {
    if (type === 'Microtask') {
      microId = id;
      events.push(['init', trigger === executionAsyncId()]);
    }
  },
  before(id) {
    if (id === microId) events.push(['before']);
  },
  after(id) {
    if (id === microId) events.push(['after']);
  },
  destroy(id) {
    if (id === microId) events.push(['destroy']);
  },
});
hook.enable();
queueMicrotask(() => events.push(['run', executionAsyncId() === microId]));
setImmediate(() => {
  console.log('events:', JSON.stringify(events));
  hook.disable();
});
