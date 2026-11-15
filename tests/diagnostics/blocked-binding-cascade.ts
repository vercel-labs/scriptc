// Uses of a binding whose DECLARATION was blocked report the SC2004
// cascade — "inherits the blocker on its declaration" — instead of
// misattributing the reference itself. The root diagnostic stays on the
// declaration site; every use points back at it.

// A poisoned declaration (BigInt64Array values are fenced, and the type
// can't be salvaged): uses of 'w' cascade — reads and writes alike. (This
// battery used Symbol before symbol values grew a lowering.)
let w = new BigInt64Array(8);
console.log(typeof w);
w = new BigInt64Array(8);

// A signature-blocked function (BigInt64Array return type) used as a
// value: the deferred signature diagnostic flushes at the reference, and
// the value use itself cascades.
function makeWm(): BigInt64Array<ArrayBuffer> {
  return new BigInt64Array(8);
}
const f = makeWm;
