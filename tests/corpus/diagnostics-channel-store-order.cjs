// Channel.bindStore/runStores/unbindStore: Node wraps the run in the bound
// stores in insertion order, so the last-bound store is outermost and its
// transform runs first; a re-bind replaces the transform in place; only an
// undefined transform is the identity (null, false, 0 and '' are stored and
// throw when runStores calls them, as a deferred uncaught exception); and a
// binding alone makes the channel active for hasSubscribers.
'use strict';
const dc = require('diagnostics_channel');
const { AsyncLocalStorage } = require('async_hooks');

const a = new AsyncLocalStorage();
const b = new AsyncLocalStorage();
const ch = dc.channel('store-order');
const events = [];
ch.bindStore(a, (data) => {
  events.push(`a:${data}`);
  return 'A' + data;
});
ch.bindStore(b, (data) => {
  events.push(`b:${data}`);
  return 'B' + data;
});
console.log('active:', ch.hasSubscribers);
ch.subscribe((message) => console.log('sub:', message, a.getStore(), b.getStore()));
console.log(
  'ret:',
  ch.runStores(1, () => {
    console.log('body:', a.getStore(), b.getStore());
    return 'ret';
  }),
);
console.log('events:', events.join(','));
console.log('outside:', a.getStore(), b.getStore());

// A re-bind replaces the transform without changing the store's position.
ch.bindStore(a, (data) => {
  events.push(`a2:${data}`);
  return 'A2' + data;
});
ch.runStores(2, () => {});
console.log('rebound:', events.slice(2).join(','));

process.on('uncaughtException', (error) => console.log('uncaught:', error.constructor.name, '|', error.message));

// A null transform is not the identity: it is stored and throws when run, so
// the store is skipped and the body still runs.
const falsy = dc.channel('store-falsy');
falsy.bindStore(a, null);
console.log('null transform body:', falsy.runStores('x', () => a.getStore()));

// An undefined transform is the identity.
const identity = dc.channel('store-undefined');
identity.bindStore(a);
console.log('undefined transform:', identity.runStores('y', () => a.getStore()));

console.log('unbind:', ch.unbindStore(a), ch.unbindStore(a), ch.unbindStore(b));
setImmediate(() => console.log('after tick'));
