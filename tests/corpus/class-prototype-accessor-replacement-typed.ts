// Accessors replaced through a TypeScript class's prototype: typed reads
// and writes observe the replacement, a data property a definition puts
// there is inherited, and an own property written through it shadows the
// prototype's, as in Node.
class Box {
  value = 3;
  get scaled(): number {
    return this.value * 2;
  }
  set scaled(next: number) {
    this.value = next / 2;
  }
  describe(): string {
    return `v${this.value}`;
  }
}
const box = new Box();
console.log(box.scaled, box.describe());
Object.defineProperty(Box.prototype, "scaled", {
  get(): number {
    return this.value * 3;
  },
  set(next: number) {
    this.value = next / 3;
  },
  enumerable: false,
  configurable: true,
});
console.log(box.scaled);
box.scaled = 9;
console.log(box.value, box.scaled, new Box().scaled);
const descriptor = Object.getOwnPropertyDescriptor(Box.prototype, "scaled");
console.log(typeof descriptor?.get, typeof descriptor?.set, descriptor?.configurable);
Object.defineProperty(Box.prototype, "scaled", { value: 5, writable: true, configurable: true });
console.log(box.scaled, Object.getOwnPropertyDescriptor(Box.prototype, "scaled")?.value);
box.scaled = 7;
console.log(box.scaled, box.value, Object.hasOwn(box, "scaled"));
class Meter {
  units = 2;
  get total(): number {
    return this.units * 10;
  }
}
Reflect.defineProperty(Meter.prototype, "total", {
  get(): number {
    return this.units * 100;
  },
  configurable: true,
});
console.log(new Meter().total);
