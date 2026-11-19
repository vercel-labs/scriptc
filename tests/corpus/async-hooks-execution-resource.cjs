// executionAsyncResource() and AsyncResource's hook participation: the
// resource an AsyncResource scope runs (and the same object every read of the
// top-level execution answers), the resource's ids as the execution's ids
// inside runInAsyncScope, and the init/before/after/destroy callbacks the
// class fires. The resource object of a timer, immediate, tick or promise
// execution is not observable here: the runtime answers one shared plain
// object outside a resource scope, so only the relations above are pinned.
'use strict';
const ah = require('async_hooks');
const { AsyncResource, createHook } = require('async_hooks');

// The top-level execution answers an object, and every read answers it again.
const top = ah.executionAsyncResource();
console.log('top:', typeof top, Object.keys(top).length, ah.executionAsyncResource() === top);

// Outside a resource scope the execution resource is not the resource; inside
// runInAsyncScope (and a bound call) it is.
const res = new AsyncResource('RES1');
console.log('outside:', ah.executionAsyncResource() === res);
console.log('inside:', res.runInAsyncScope(() => ah.executionAsyncResource() === res));

// The resource's ids are the execution's ids inside the scope. The numbers are
// opaque (Node's counter also numbers its loader's internals), so only the
// relations are pinned.
console.log(
  'ids:',
  res.runInAsyncScope(
    () =>
      ah.executionAsyncId() === res.asyncId() &&
      ah.triggerAsyncId() === res.triggerAsyncId(),
  ),
);

// A resource built inside another one's scope takes its trigger from it.
let nestedTrigger = false;
const outer = new AsyncResource('OUTER');
outer.runInAsyncScope(() => {
  const inner = new AsyncResource('INNER');
  nestedTrigger = inner.triggerAsyncId() === outer.asyncId();
});
console.log('nested trigger:', nestedTrigger);

// AsyncResource's callbacks: init carries the resource and its ids, before and
// after bracket the scope, and destroy arrives from a later tick than
// emitDestroy itself.
let res2;
const events = [];
const initTypes = [];
const hook = createHook({
  init(id, type, trigger, resource) {
    initTypes.push(type);
    if (type === 'RES2')
      events.push(['init', type, resource.asyncId() === id, trigger === resource.triggerAsyncId()]);
  },
  before(id) {
    if (id === res2.asyncId()) events.push(['before']);
  },
  after(id) {
    if (id === res2.asyncId()) events.push(['after']);
  },
  destroy(id) {
    if (id === res2.asyncId()) events.push(['destroy']);
  },
});
hook.enable();
res2 = new AsyncResource('RES2');
res2.runInAsyncScope(() => {});
res2.emitDestroy();
console.log('events sync:', JSON.stringify(events));

// An empty type is refused only while an init hook is enabled.
hook.disable();
let disabled = 'ok';
try {
  new AsyncResource('');
} catch (error) {
  disabled = error.code;
}
console.log('empty type disabled:', disabled);
hook.enable();
try {
  new AsyncResource('');
} catch (error) {
  console.log('empty type enabled:', error.code, JSON.stringify(error.message));
}

// Static bind builds a resource named after the function, so an enabled init
// hook sees it.
AsyncResource.bind(function named(a) {
  return a;
})(1);
console.log('bound init type:', initTypes.includes('named'));

// The destroy waits for a later iteration: absent above and present in the
// immediate below, before the hook is disabled.
setImmediate(() => {
  console.log('events later:', JSON.stringify(events));
  hook.disable();
});
