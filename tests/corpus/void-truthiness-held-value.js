// A truthiness test of a CONST binding that holds what a void-typed call
// answered. The checker types the call `void` (the member's JSDoc
// signature), while Node tests the value the function the program stored
// there returned, so the binding has to keep that value.
'use strict';

/** @type {{ d: { f: () => void } }} */
const Truthy = { d: { f: function () { return 1; } } };
const truthy = Truthy.d.f();
console.log(truthy ? 'truthy' : 'falsy', !truthy, Boolean(truthy), truthy);
console.log(truthy ? 'conditional-yes' : 'conditional-no');

/** @type {{ d: { f: () => void } }} */
const Falsy = { d: { f: function () { return 0; } } };
const falsy = Falsy.d.f();
if (falsy) console.log('unreachable');
else console.log('falsy', falsy);

/** @type {{ d: { f: () => void } }} */
const Empty = { d: { f: function () {} } };
const empty = Empty.d.f();
console.log(empty ? 'unreachable' : 'undefined', empty === undefined);

let calls = 0;
/** @type {{ d: { f: () => void } }} */
const Counted = {
  d: {
    f: function () {
      calls += 1;
      return 'counted';
    },
  },
};
const counted = Counted.d.f();
if (counted) console.log(counted, calls);
else console.log('unreachable', calls);

// The shape react-dom's `flushSyncWork` has: two `var`s hold void-typed
// results, and the function returns their `||`. The checker types both
// `void`; Node returns the value the first call answered.
/** @type {{ d: { f: () => void } }} */
const Dispatcher = {
  d: {
    f: function () {
      return undefined;
    },
  },
};
let flushes = 0;
function flushSyncWork$1() {
  flushes += 1;
}
function flushSyncWork() {
  var previousWasRendering = Dispatcher.d.f(),
    wasRendering = flushSyncWork$1();
  return previousWasRendering || wasRendering;
}
Dispatcher.d.f = function () {
  return 'rendered';
};
console.log(flushSyncWork(), flushes);
