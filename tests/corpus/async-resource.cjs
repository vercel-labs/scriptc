// AsyncResource (node:async_hooks) — the class libraries use to run a
// callback in the async context that was active when a resource was made:
// construction captures the AsyncLocalStorage context and takes Node's
// async ids, runInAsyncScope installs that context for the call (arguments,
// receiver, result and throws pass through), bind answers a function doing
// the same, the constructor's type/triggerAsyncId checks raise Node's
// errors, and emitDestroy answers the resource.
'use strict';
const { AsyncResource, AsyncLocalStorage } = require('async_hooks');
const assert = require('assert');

const als = new AsyncLocalStorage();

// Ids: a resource answers a positive id (the root execution is 1) and the
// id of the execution that made it.
const res = new AsyncResource('TEST');
console.log('ids:', typeof res.asyncId(), res.asyncId() >= 2, typeof res.triggerAsyncId());

// runInAsyncScope forwards the receiver, the arguments and the result.
const scope = { tag: 'scope' };
console.log(
  'run:',
  res.runInAsyncScope(function (a, b) {
    return `${this.tag}:${a + b}`;
  }, scope, 1, 2),
);

// A throw inside the scope propagates, and the caller's context is intact.
try {
  res.runInAsyncScope(() => {
    throw new Error('boom');
  });
} catch (error) {
  console.log('threw:', error.message);
}
try {
  res.runInAsyncScope(5);
} catch (error) {
  console.log('non-function:', error.constructor.name, error.message);
}

// The store active at construction is installed inside the scope, even from
// a different store's context.
als.run('captured', () => {
  const inner = new AsyncResource('INNER');
  als.run('other', () => {
    console.log('scoped store:', inner.runInAsyncScope(() => als.getStore()));
    console.log('bound store:', inner.bind(() => als.getStore())());
  });
});
console.log('outside:', als.getStore());

// Static bind: Node's type defaulting (fn.name, then
// 'bound-anonymous-fn') and the bound function's name and length.
const bound = AsyncResource.bind(function (a, b) {
  return a + b;
});
console.log('static:', bound(1, 2), bound.name, bound.length);
const arithmetic = AsyncResource.bind(function (a) {
  return a * 2;
});
console.log('defaulted type:', arithmetic(3), arithmetic.name, arithmetic.length);
const three = AsyncResource.bind(function abc(a, b, c) {});
console.log('anonymous name:', three.name, three.length);

// A bound function without a thisArg runs its callback with the receiver it
// was invoked with (Node's bound function forwards its own `this`); an
// explicit thisArg always wins.
const holder = { tag: 'holder' };
holder.f = res.bind(function (x) {
  return [this === undefined ? 'undefined-receiver' : this.tag, x];
});
console.log('bound receiver:', JSON.stringify(holder.f(1)));
const fixedThis = res.bind(function () {
  return this.tag;
}, { tag: 'fixed' });
console.log('bound explicit thisArg:', fixedThis());

// Instance bind, and emitDestroy answering the same resource every call.
const plus = res.bind(function (x) {
  return x + 1;
});
console.log('instance bind:', plus(41), plus.name, plus.length);
assert.strictEqual(res.emitDestroy(), res);
assert.strictEqual(res.emitDestroy(), res);
console.log('destroyed twice: ok');

// Constructor and argument checks, Node's errors and messages.
try {
  new AsyncResource();
} catch (error) {
  console.log('no type:', error.code, error.message);
}
try {
  new AsyncResource(1);
} catch (error) {
  console.log('number type:', error.code, error.message);
}
try {
  new AsyncResource('T', { triggerAsyncId: 1.5 });
} catch (error) {
  console.log('fractional trigger:', error.code, error.message);
}
try {
  new AsyncResource('T', { triggerAsyncId: 'x' });
} catch (error) {
  console.log('string trigger:', error.code, error.message);
}
try {
  res.bind(null);
} catch (error) {
  console.log('bind non-function:', error.code, error.message);
}
try {
  AsyncResource.bind(null);
} catch (error) {
  console.log('static bind null:', error.constructor.name, error.message);
}
try {
  AsyncResource.bind(() => {}, 5);
} catch (error) {
  console.log('static bind type:', error.code, error.message);
}

// A resource held as an untyped value takes the same checks as a typed one:
// bind rejects a non-function at the bind call (not at the bound call), and
// runInAsyncScope answers Node's own apply error.
const bindOf = (resource) => resource.bind(5);
const runOf = (resource) => resource.runInAsyncScope(5);
try {
  bindOf(res);
} catch (error) {
  console.log('dynamic bind non-function:', error.code, '|', error.message);
}
try {
  runOf(res);
} catch (error) {
  console.log('dynamic run non-function:', error.message);
}
