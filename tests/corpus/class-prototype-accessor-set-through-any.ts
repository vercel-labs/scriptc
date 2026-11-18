// A numeric accessor written through an `any` instance after its prototype
// accessor is replaced: the replaced setter and getter observe the write, as
// in Node.
class Counter {
  value = 0;
  get level(): number {
    return this.value;
  }
  set level(next: number) {
    this.value = next;
  }
}
Object.defineProperty(Counter.prototype, "level", {
  get(this: Counter) {
    return this.value * 10;
  },
  set(this: Counter, next: number) {
    this.value = next;
  },
  configurable: true,
});
const counter: any = new Counter();
counter.level = 4;
console.log(counter.level, counter.value);
counter.level = 7;
console.log(counter.level, counter.value);
console.log(Object.getOwnPropertyDescriptor(Counter.prototype, "level")?.configurable);
