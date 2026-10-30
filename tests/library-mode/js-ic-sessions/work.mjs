// Dynamic-tier property caches across library sessions: objects built empty
// and filled through untyped stores or built by object literals, read back
// through untyped loads, and a class instance at the same kind of sites. Each session must start with
// empty caches, since the shapes their entries named are freed when the
// previous session ends.
class Box {
  constructor(v) {
    this.v = v;
  }
}
function fill(o, n) {
  o.a = n;
  o.b = n + 1;
  return o;
}
function pair(n) {
  return { a: n, b: n + 1 };
}
function sum(o) {
  return o.a + o.b;
}
function unbox(b) {
  return b.v;
}
export function runAll() {
  let total = 0;
  for (let i = 0; i < 100; i++) total += sum(fill({}, i)) + sum(pair(i));
  return total + unbox(new Box(total));
}
