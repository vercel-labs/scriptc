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
class Sub extends Base {}
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
