'use strict';
// A Microtask's destroy waits for the whole due-timer batch: the rest of the
// timers phase runs before the destroy phase, as in Node, and the microtask's
// own callback runs between its timer and the next one.
const { createHook } = require('async_hooks');
const order = [];
const microIds = new Set();
let last = 0;
const hook = createHook({
  init(id, type) {
    if (type === 'Microtask') last = id;
  },
  destroy(id) {
    if (microIds.has(id)) order.push('destroy');
  },
});
hook.enable();
setTimeout(() => {
  order.push('timer-a');
  queueMicrotask(() => order.push('microtask'));
  microIds.add(last);
}, 1);
setTimeout(() => order.push('timer-b'), 1);
setTimeout(() => order.push('timer-c'), 1);
setTimeout(() => {
  hook.disable();
  console.log(order.join(','));
}, 20);
