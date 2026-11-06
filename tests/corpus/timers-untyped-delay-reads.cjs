// @normalize-pid
'use strict';
// An untyped delay converts as Node's `after *= 1` does: a BigInt delay
// throws its TypeError from setTimeout and setInterval, called directly or
// as stored function values, and a delay read from an untyped array that
// converts to NaN warns, while an element read past the end is undefined,
// the default delay, and warns nothing. A stored function value warns as
// the direct call does.
const big = [1n];
try {
  setTimeout(() => console.log('not reached'), big[0]);
} catch (error) {
  console.log('direct', error.name, error.message);
}
for (const schedule of [setTimeout, setInterval]) {
  try {
    schedule(() => console.log('not reached'), 1n);
    console.log('no throw');
  } catch (error) {
    console.log(error.name, error.message);
  }
}
const delays = [{}, 'x', 1];
setTimeout(() => console.log('past the end'), delays[9]);
setTimeout(() => console.log('object element'), delays[0]);
setTimeout(() => console.log('string element'), delays[1]);
const stored = [setTimeout][0];
stored(() => console.log('stored negative'), -5);
