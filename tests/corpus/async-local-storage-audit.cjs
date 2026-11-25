// AsyncLocalStorage (node:async_hooks) — the documented behavior audit:
// run()'s result and forwarded arguments, exit() clearing for its window,
// nested runs shadowing and restoring, the constructor's defaultValue and
// name, enterWith() reaching the resources created after it (Node's
// init-time capture), disable() clearing the store and stopping that
// propagation, microtasks inheriting the store, and a timer callback's
// store surviving an await inside it. Every phase below is scheduled from
// the phase before it, so the output order is causal rather than timed.
'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const assert = require('assert');

const als = new AsyncLocalStorage();
const withDefault = new AsyncLocalStorage({ defaultValue: 'DEF', name: 'named' });

// run: the callback's result, the extra arguments, and the store's identity.
const outerStore = { name: 'outer' };
const result = als.run(outerStore, (a, b) => {
  assert.strictEqual(als.getStore(), outerStore);
  return `${a}-${b}`;
}, 1, 2);
console.log('run result:', result, '| after:', String(als.getStore()));

// exit() clears the store for its window only; nested runs shadow.
als.run('outer', () => {
  console.log('exit window:', String(als.exit(() => als.getStore())));
  console.log('after exit:', als.getStore());
  als.run('inner', () => console.log('nested:', als.getStore()));
  console.log('restored:', als.getStore());
});

// The constructor's options.
console.log('default name:', JSON.stringify(withDefault.name), '| plain:', JSON.stringify(als.name));
console.log('default store:', withDefault.getStore());
withDefault.run(undefined, () => console.log('run undefined:', String(withDefault.getStore())));
withDefault.run('set', () => console.log('run set:', withDefault.getStore()));

// A microtask queued inside a run inherits its store.
als.run('micro', () => {
  console.log('micro run:', als.getStore());
  queueMicrotask(() => console.log('microtask:', als.getStore()));
});

// enterWith inside a run reaches the resources created after it; disable()
// clears the store and stops that propagation.
als.run('entered', () => {
  als.enterWith('changed');
  console.log('after enterWith:', als.getStore());
  setImmediate(() => {
    console.log('immediate:', als.getStore());
    als.disable();
    console.log('after disable:', String(als.getStore()));
    setImmediate(async () => {
      console.log('later immediate:', String(als.getStore()));
      als.run('awaited', () => {
        setTimeout(async () => {
          console.log('timer start:', als.getStore());
          await null;
          console.log('timer after await:', als.getStore());
        }, 1);
      });
    });
  });
});
