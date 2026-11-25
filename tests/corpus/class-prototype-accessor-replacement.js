// Accessors replaced through a class's prototype: Object.defineProperty,
// Reflect.defineProperty and Object.defineProperties. Instances read and
// write the replacement (own properties shadow it, as in Node), the
// prototype itself runs the accessor with the prototype as `this`, and a
// data property a definition puts there is what instances inherit.
class Box {
  constructor(value) {
    this.value = value;
  }
  get scaled() {
    return this.value * 2;
  }
  set scaled(next) {
    this.value = next / 2;
  }
  describe() {
    return `v${this.value}`;
  }
}
const box = new Box(3);
console.log(box.scaled, box.describe());
Object.defineProperty(Box.prototype, "scaled", {
  get() {
    return this.value * 3;
  },
  set(next) {
    this.value = next / 3;
  },
  enumerable: false,
  configurable: true,
});
console.log(box.scaled);
box.scaled = 9;
console.log(box.value, box.scaled, new Box(2).scaled);
const descriptor = Object.getOwnPropertyDescriptor(Box.prototype, "scaled");
console.log(typeof descriptor.get, typeof descriptor.set, descriptor.enumerable, descriptor.configurable);
Object.defineProperty(Box.prototype, "scaled", { value: 5, writable: true, configurable: true });
console.log(box.scaled, Box.prototype.scaled);
box.scaled = 7;
console.log(box.scaled, box.value, Object.hasOwn(box, "scaled"));
const made = Object.create(Box.prototype);
made.value = 4;
console.log(made.scaled);
class Meter {
  constructor() {
    this.units = 2;
  }
  get total() {
    return this.units * 10;
  }
}
Reflect.defineProperty(Meter.prototype, "total", {
  get() {
    return this.units * 100;
  },
  configurable: true,
});
console.log(new Meter().total);
class Tag {
  constructor() {
    this.name = "a";
  }
  get label() {
    return this.name + "!";
  }
}
Object.defineProperties(Tag.prototype, {
  label: {
    get() {
      return this.name + "?";
    },
    configurable: true,
  },
});
console.log(new Tag().label);
class Watch {
  constructor() {
    this.n = 1;
  }
  get size() {
    return this.n;
  }
  set size(v) {
    this.n = v;
  }
}
console.log(Watch.prototype.size);
Watch.prototype.size = 5;
console.log(Watch.prototype.n, new Watch().size);
