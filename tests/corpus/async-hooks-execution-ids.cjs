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
// An explicit null is present, not absent: Node raises ERR_ASYNC_CALLBACK for
// it, unlike the undefined a missing member reads.
show('createHook({ init: null })', () => ah.createHook({ init: null }));
show('createHook({ after: null })', () => ah.createHook({ after: null }));
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
// Promise resources are counted while the growth section below creates its
// batch, so only those promises' settlements are tallied.
const track = { collect: false, ids: new Set(), resolved: new Set() };
const hook = ah.createHook({
  init(id, type, trigger) {
    types.add(type);
    if (track.collect && type === 'PROMISE') track.ids.add(id);
    if (typeof id !== 'number' || typeof trigger !== 'number') relations = false;
  },
  promiseResolve(id) {
    if (track.ids.has(id)) track.resolved.add(id);
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

// An inline literal's members are evaluated in SOURCE order (the literal is
// built before createHook reads it), not in the order of the five slots.
// Members that are not callbacks still run, for their side effects.
const literalOrder = [];
const noop = () => {};
ah.createHook({
  promiseResolve: (literalOrder.push('promiseResolve'), noop),
  destroy: (literalOrder.push('destroy'), noop),
  tail: literalOrder.push('tail'),
  after: (literalOrder.push('after'), noop),
  before: (literalOrder.push('before'), noop),
  init: (literalOrder.push('init'), noop),
});
console.log('literal members evaluated:', literalOrder.join(','));

// Quoted keys and spreads still name the same callbacks.
const spreadOrder = [];
ah.createHook({
  ...{ promiseResolve: (spreadOrder.push('spread'), noop) },
  'init': (spreadOrder.push('quoted init'), noop),
});
console.log('spread and quoted keys:', spreadOrder.join(','));

// Each phase schedules the next, so the output order is causal rather than
// timed.
process.nextTick(() => {
  console.log('tick above root:', ah.executionAsyncId() > 1);
  setTimeout(() => {
    console.log('timer above root:', ah.executionAsyncId() > 1);
    console.log('timer trigger is an id:', typeof ah.triggerAsyncId() === 'number');
    setImmediate(() => {
      // The promise-resource table grows past its initial capacity while
      // hundreds of promises stay live: every one of them must still find
      // its entry when it settles, or its promiseResolve event disappears.
      const resolvers = [];
      const batch = [];
      track.collect = true;
      for (let i = 0; i < 200; i++) batch.push(new Promise((resolve) => resolvers.push(resolve)));
      track.collect = false;
      const total = track.ids.size;
      for (const resolve of resolvers) resolve(total);
      Promise.all(batch).then(() => {
        console.log('promise table growth:', total, track.resolved.size === total);
        hook.disable();
        const seen = ['Timeout', 'Immediate', 'TickObject'].every((type) => types.has(type));
        console.log('modelled types seen:', seen);
        console.log('hook id relations:', relations);
        console.log('disable answers the hook:', hook.disable() === hook);

        // A computed member name is a callback like any other.
        const key = 'promiseResolve';
        const computedOrder = [];
        ah.createHook({ [key]: (computedOrder.push('computed'), noop) });
        console.log('computed key:', computedOrder.join(','));

        // An init hook may queue another immediate while this one is being
        // queued: the outer callback must survive (Node queues the hook's
        // immediate first, so it runs first) and no phantom queue entry may
        // be left behind.
        const immediateOrder = [];
        let queuedInner = false;
        const queueHook = ah.createHook({
          init(id, type) {
            if (type !== 'Immediate' || queuedInner) return;
            queuedInner = true;
            setImmediate(() => immediateOrder.push('nested'));
          },
        });
        queueHook.enable();
        setImmediate(() => immediateOrder.push('outer'));
        setImmediate(() => {
          queueHook.disable();
          console.log('immediate from init:', immediateOrder.join(','));

          // A promise resource dies with its promise: across a long
          // create/await churn no entry may survive to answer for a later
          // promise at a recycled address. Two identical churns leave the
          // same set of unfinished ids behind; a third round of dropped
          // resolutions means the table kept entries for dead promises. The
          // absolute count is the host's own pending internals, so only the
          // growth between the rounds is pinned.
          const churnLive = new Set();
          const churnHook = ah.createHook({
            init(id, type) {
              if (type === 'PROMISE') churnLive.add(id);
            },
            promiseResolve(id) {
              churnLive.delete(id);
            },
          });
          churnHook.enable();
          (async () => {
            const churn = async () => {
              for (let i = 0; i < 2000; i++) await Promise.resolve(i);
            };
            await churn();
            const first = churnLive.size;
            await churn();
            const second = churnLive.size;
            churnHook.disable();
            console.log('promise churn growth:', second - first);
          })();
        });
      });
    });
  }, 1);
});
