// A for-in or for-of loop stores its var binding only when it iterates:
// after a loop that ran zero times, closures read undefined.
function f(o) {
  for (var key in o) {}
  const read = () => typeof key;
  const same = () => key === undefined;
  return [read(), same()];
}
console.log(JSON.stringify(f({})), JSON.stringify(f({ a: 1 })));
function g(xs) {
  for (var x of xs) {}
  const show = () => [typeof x, String(x)];
  return show();
}
console.log(JSON.stringify(g([])), JSON.stringify(g([4])));
for (var top in {}) {}
const readTop = () => typeof top;
console.log(readTop());
