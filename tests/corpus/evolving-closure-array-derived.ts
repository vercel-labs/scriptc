// Derived values of an evolving-`any` closure array, at file scope and in
// a function body: slice and concat preserve the handle-element array
// (JS's IsArray decides concat's spread over the VALUE, not the evolved
// checker spelling), and the function-scope filter result adopts the
// handle-element type through the local declaration.
const fns = [];
fns.push(() => 1);
fns.push(() => 2);
fns.push(() => 3);
const tail = fns.slice(1);
console.log(tail.length);
tail.forEach(fn => console.log(fn()));
const both = fns.concat(tail);
console.log(both.length);
console.log(both.map(fn => fn()));

function pick(limit: number) {
  const cbs = [];
  cbs.push(() => limit);
  cbs.push(() => limit * 2);
  const kept = cbs.filter(fn => fn() > limit);
  return kept.map(fn => fn());
}
console.log(pick(4));
