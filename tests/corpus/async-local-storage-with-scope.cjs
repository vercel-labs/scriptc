// asyncLocalStorage.withScope (node:async_hooks, Node 24) — the RunScope a
// `using` declaration disposes: withScope installs the store now, keeps the
// value getStore() answered before it (defaultValue included), and its
// dispose() puts that value back (a second dispose is a no-op, and a
// nested store's dispose only touches its own storage). [Symbol.dispose]
// is the same disposal, so `using` scopes the store to a block.
'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const assert = require('assert');

const als = new AsyncLocalStorage({ defaultValue: 'default', name: 'store' });
const show = (label) => console.log(label, als.getStore());
assert.strictEqual(als.name, 'store');

show('initial');

const outer = als.withScope('outer');

// A RunScope is a native handle that models no data properties: an
// unmodeled name reads undefined and `in` answers false (there is no getter
// behind it), while its dispose stays a method value.
console.log(
  'scope reads:',
  outer.missing,
  '|',
  'missing' in outer,
  '| dispose:',
  typeof outer.dispose,
);
console.log('scope type:', typeof outer, Object.keys(outer).length);
show('after withScope');
const inner = als.withScope('inner');
show('nested');
inner.dispose();
show('after inner dispose');
inner.dispose();
show('double dispose');
outer.dispose();
show('after outer dispose');

// A scope disposed inside another context restores there; the enclosing
// run() keeps its own store.
als.run('run-store', () => {
  const scope = als.withScope('scoped');
  als.run('deeper', () => {
    scope.dispose();
    show('disposed inside deeper');
  });
  show('back in the run');
});

// `using` disposes at the end of the block.
als.run('outer', () => {
  {
    using scope = als.withScope('using');
    show('inside using');
    assert.strictEqual(scope[Symbol.dispose] instanceof Function, true);
  }
  show('after using');
});

// A store established only by withScope still reaches the callbacks
// scheduled after it: the runtime's *_als scheduling entry points carry
// the active stores into each callback.
als.withScope('scheduled');
setImmediate(() => console.log('withScope immediate:', als.getStore()));

// dispose() during an ordinary store: the store before the scope returns.
als.run('ordinary', () => {
  const scope = als.withScope('temporary');
  show('inside scope');
  scope.dispose();
  show('restored');
});
