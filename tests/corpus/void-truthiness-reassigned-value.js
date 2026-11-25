// A truthiness test over a variable that a later void-typed member call
// reassigns: Node's assignment stores the value the call answered, so the
// test reads the reassigned value, not undefined.
'use strict';

/** @type {{ d: { f: () => void } }} */
const First = { d: { f: function () { return 'init'; } } };
/** @type {{ d: { f: () => void } }} */
const Second = { d: { f: function () { return 'assigned'; } } };
/** @type {{ d: { f: () => void } }} */
const Zero = { d: { f: function () { return 0; } } };

let value = First.d.f();
value = Second.d.f();
if (value) console.log('truthy', value);
else console.log('falsy', value);

value = Zero.d.f();
if (value) console.log('truthy', value);
else console.log('falsy', value);

function scoped() {
  var held = First.d.f();
  held = Second.d.f();
  return held ? 'scoped-true' : 'scoped-false';
}
console.log(scoped());
