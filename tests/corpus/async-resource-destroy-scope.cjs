// AsyncResource after emitDestroy: Node keeps the async context the resource
// captured, so a runInAsyncScope call or a bound callback made after the
// destroy still runs inside the store the resource was created in; the store
// it was created in wins over an unrelated store that is current at the call,
// a second destroy changes nothing, and a resource created outside any store
// answers undefined.
'use strict';
const { AsyncLocalStorage, AsyncResource } = require('async_hooks');

const als = new AsyncLocalStorage();

als.run('request-store', () => {
  const resource = new AsyncResource('REQUEST');
  console.log(
    'ids:',
    Number.isInteger(resource.asyncId()),
    Number.isInteger(resource.triggerAsyncId()),
  );
  resource.emitDestroy();
  console.log('runInAsyncScope after destroy:', resource.runInAsyncScope(() => als.getStore()));
  const bound = resource.bind(() => als.getStore());
  console.log('bound after destroy:', bound());
  resource.emitDestroy();
  console.log('second destroy:', resource.runInAsyncScope(() => als.getStore()));
  als.run('other-store', () => {
    console.log(
      'inside another store:',
      resource.runInAsyncScope(() => als.getStore()),
      bound(),
    );
  });
});
console.log('outside:', als.getStore());

const detached = new AsyncResource('DETACHED');
detached.emitDestroy();
console.log('detached scope:', detached.runInAsyncScope(() => als.getStore()));
const detachedBound = detached.bind(() => als.getStore());
console.log('detached bound:', detachedBound());
