// Object.is accepts a subclass instance against a union with its base
// class arm, comparing the same object identity as strict equality.
class Base {
  n = 1;
}
class Child extends Base {
  m = 2;
}
function check(u: Base | { label: string }, s: Child): void {
  console.log(u === s, Object.is(u, s), Object.is(s, u), u !== s);
}
const shared = new Child();
check(shared, shared);
check(new Child(), shared);
check(new Base(), shared);
check({ label: "plain" }, shared);
