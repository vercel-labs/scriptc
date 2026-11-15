// A base constructor calls a method the derived class overrides, and the
// override reads the derived class's own fields. Their initializers have
// not run yet, so each field reads undefined, whatever its type.

class Base {
  constructor() {
    console.log("in base constructor:", this.describe());
  }
  describe(): string {
    return "base";
  }
}

class Derived extends Base {
  extra = 5;
  label = "L";
  describe(): string {
    return typeof this.extra + ":" + this.extra + " " + typeof this.label + ":" + this.label;
  }
}
const derived = new Derived();
console.log("after:", derived.describe());

// A field initializer of the base makes the call.
class Sup {
  v = this.init();
  init(): number {
    return 1;
  }
}
class Sub extends Sup {
  w = 10;
  init(): number {
    return this.w === undefined ? -1 : this.w;
  }
}
console.log(new Sub().v, new Sup().v);

// Every slot kind.
class Item {
  id = 1;
}
class Shape {
  constructor() {
    console.log("early:", this.state());
  }
  state(): string {
    return "shape";
  }
}
class Box extends Shape {
  width = 2.5;
  count = 3;
  open = true;
  title = "box";
  big = 10n;
  items: number[] = [1];
  byName = new Map<string, number>();
  tags = new Set<string>();
  item = new Item();
  size: { w: number } = { w: 1 };
  scale: (x: number) => number = (x) => x * 2;
  either: string | number = "e";
  state(): string {
    return [
      typeof this.width,
      this.width === undefined,
      typeof this.count,
      this.count ?? -1,
      typeof this.open,
      this.open ? "open" : "closed",
      typeof this.title,
      this.title ?? "untitled",
      typeof this.big,
      this.big === undefined,
      typeof this.items,
      this.items === undefined,
      typeof this.byName,
      this.byName !== undefined,
      typeof this.tags,
      this.tags == null,
      typeof this.item,
      this.item ? "item" : "no item",
      typeof this.size,
      this.size === undefined,
      typeof this.scale,
      this.scale === undefined,
      typeof this.either,
      this.either === undefined,
    ].join(" ");
  }
}
const box = new Box();
console.log("late:", box.state());
console.log(box.width + box.count, box.title.length, box.items.length, box.byName.size, box.scale(4));

// A read of the unassigned field that needs its value: a member read
// throws Node's TypeError, arithmetic gives NaN, a string reads
// "undefined".
function typeError(e: unknown): string {
  return e instanceof TypeError ? "TypeError" : "other";
}
class Probe {
  constructor() {
    this.run();
  }
  run(): void {}
}
class Uses extends Probe {
  n = 1;
  s = "s";
  a: number[] = [];
  m = new Map<string, number>();
  run(): void {
    console.log("n + 1", this.n + 1);
    try {
      console.log("s.length", this.s.length);
    } catch (e) {
      console.log("s.length threw", typeError(e));
    }
    try {
      console.log("a.length", this.a.length);
    } catch (e) {
      console.log("a.length threw", typeError(e));
    }
    try {
      console.log("m.size", this.m.size);
    } catch (e) {
      console.log("m.size threw", typeError(e));
    }
    console.log("String(n)", String(this.n));
    console.log("template", `${this.s}`);
    console.log("truthy", (this.n ? 1 : 0) + (this.s ? 1 : 0) + (this.a ? 1 : 0) + (this.m ? 1 : 0));
  }
}
new Uses().run();
