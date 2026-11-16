// node:async_hooks — the execution ids and the hook callbacks, pinned by
// their relations rather than by the numbers: Node's ids are an opaque
// counter that also numbers its module-loading internals, so only these
// hold across implementations — the root execution is id 1 with trigger 0,
// a timer or tick callback runs above the root, a hook's before/after see
// the id of the resource they run for, and init/destroy/ids cross as
// numbers with the modelled resource types. createHook's argument errors
// are Node's own.
'use strict';
const ah = require('async_hooks');
const show = (label, fn) => {
  try {
    fn();
    console.log(label, '=> ok');
  } catch (error) {
    console.log(label, '=>', error.code, error.message);
  }
};

show('createHook()', () => ah.createHook());
show('createHook({ init: 5 })', () => ah.createHook({ init: 5 }));
show('createHook({ promiseResolve: "x" })', () => ah.createHook({ promiseResolve: 'x' }));
show('createHook(5)', () => ah.createHook(5));

// The numbers themselves are opaque (a loader numbers resources before the
// entry runs, and Node reports no execution id at all in some of those
// environments), so the root is pinned by its shape.
console.log(
  'root:',
  typeof ah.executionAsyncId() === 'number',
  typeof ah.triggerAsyncId() === 'number' && ah.triggerAsyncId() >= 0,
);

// asyncWrapProviders: Node's published provider table, a null-prototype
// object whose names are its own enumerable properties.
const providers = ah.asyncWrapProviders;
console.log(
  'providers:',
  Object.prototype.toString.call(providers),
  Object.getPrototypeOf(providers) === null,
  Object.keys(providers).length,
);
console.log(
  'provider ids:',
  providers.NONE,
  providers.PROMISE,
  providers.TCPWRAP,
  String(providers.TIMERWRAP),
);

let relations = true;
const types = new Set();
const hook = ah.createHook({
  init(id, type, trigger) {
    types.add(type);
    if (typeof id !== 'number' || typeof trigger !== 'number') relations = false;
  },
  before(id) {
    if (id !== ah.executionAsyncId()) relations = false;
  },
  after(id) {
    if (id !== ah.executionAsyncId()) relations = false;
  },
  destroy(id) {
    if (typeof id !== 'number') relations = false;
  },
});
const enabled = hook.enable();
console.log('enable answers the hook:', enabled === hook);

// Each phase schedules the next, so the output order is causal rather than
// timed.
process.nextTick(() => {
  console.log('tick above root:', ah.executionAsyncId() > 1);
  setTimeout(() => {
    console.log('timer above root:', ah.executionAsyncId() > 1);
    console.log('timer trigger is an id:', typeof ah.triggerAsyncId() === 'number');
    setImmediate(() => {
      hook.disable();
      const seen = ['Timeout', 'Immediate', 'TickObject'].every((type) => types.has(type));
      console.log('modelled types seen:', seen);
      console.log('hook id relations:', relations);
      console.log('disable answers the hook:', hook.disable() === hook);
    });
  }, 1);
});
