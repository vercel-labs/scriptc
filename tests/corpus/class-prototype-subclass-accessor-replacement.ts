// An accessor replaced on a subclass prototype: reads and writes through
// the subclass observe the replacement, while the base keeps its own, as in
// Node.
class Base {
  value = 0;
  get scaled(): number {
    return this.value;
  }
  set scaled(next: number) {
    this.value = next;
  }
}
class Middle extends Base {}
class Sub extends Base {}
class GrandSub extends Sub {}
Object.defineProperty(Sub.prototype, "scaled", {
  get(this: Sub) {
    return this.value * 10;
  },
  set(this: Sub, next: number) {
    this.value = next + 1;
  },
  configurable: true,
});
const sub = new Sub();
sub.scaled = 4;
console.log(sub.scaled, sub.value);
const base = new Base();
base.scaled = 4;
console.log(base.scaled, base.value);
const anySub: any = sub;
console.log(anySub.scaled);
console.log(typeof Object.getOwnPropertyDescriptor(Sub.prototype, "scaled")?.get);

// A base-class parameter names the member, but the instance's own prototype
// answers: reads and writes through it observe the replacement, and a
// sibling class that replaced nothing keeps the base's accessor.
function read(base: Base): number {
  return base.scaled;
}
function write(base: Base, next: number): void {
  base.scaled = next;
}
const throughBase = new GrandSub();
throughBase.value = 2;
console.log(read(throughBase));
write(throughBase, 9);
console.log(throughBase.value, read(throughBase));
const plainBase = new Base();
plainBase.value = 2;
console.log(read(plainBase));
const middle = new Middle();
middle.value = 2;
console.log(read(middle));
