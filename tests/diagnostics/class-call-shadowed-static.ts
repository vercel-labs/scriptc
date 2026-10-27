// Through a class value that may hold a subclass, `C.call(...)` reaches the
// subclass's own static `call` when it declares one, so the call is not the
// constructor call that throws Node's TypeError.
class Base {
  n = 1;
}
class OwnCall extends Base {
  static call(value: unknown): string {
    return `own call ${typeof value}`;
  }
}
function callThrough(C: typeof Base): unknown {
  return C.call(new Base());
}
console.log(callThrough(OwnCall));
