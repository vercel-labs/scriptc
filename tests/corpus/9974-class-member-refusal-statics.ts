// A static method whose signature has no mapping is left out without rejecting its class, and a
// class keeps working beside a member the build cannot compile when one of its FIELDS needs the
// checked-dynamic slot the declaration retry gives it (the retry used to give up on the class).
type Both = { (x: number): number; (x: string): string };
class Registry {
  static count = 0;
  n = 1;
  static watch(ref: WeakRef<object>): number {
    return ref.deref() === undefined ? 0 : 1;
  }
  static bump(): number {
    return ++Registry.count;
  }
  inc(): number {
    return ++this.n;
  }
}
class Child extends Registry {
  static twice(): number {
    return Registry.bump() * 2;
  }
}
class Panel {
  n = 1;
  hook: Both | undefined = undefined;
  watch(ref: WeakRef<object>): number {
    return ref.deref() === undefined ? 0 : 1;
  }
  inc(): number {
    return ++this.n;
  }
}
console.log(Registry.bump(), new Registry().inc(), Registry.count, Child.twice(), Child.bump());
const panel = new Panel();
console.log(panel.inc(), panel.hook === undefined, panel instanceof Panel);
