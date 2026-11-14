// Class values of subclasses whose constructors take other parameters
// than their base's, held in slots of the base's class value type, as a
// custom element registry holds them. Construction through the slot runs
// the constructor of the class the slot holds, with the arguments as
// written.

class Element {
  tag: string;
  constructor(tag?: string, id?: string) {
    this.tag = tag ?? "x-el";
    if (id !== undefined) this.tag += "#" + id;
  }
  static kind = "element";
  describe(): string {
    return "<" + this.tag + ">";
  }
}

const registry = new Map<string, typeof Element>();
const elements = {
  define(name: string, ctor: typeof Element): void {
    registry.set(name, ctor);
  },
  create(name: string): Element {
    const C = registry.get(name)!;
    return new C();
  },
  createWith(name: string, tag: string): Element {
    const C = registry.get(name)!;
    return new C(tag);
  },
};

class Field extends Element {
  constructor() {
    super("field");
  }
}

class Labeled extends Element {
  label: string;
  constructor(label: string = "untitled", ...rest: string[]) {
    super("labeled");
    this.label = label + (rest.length > 0 ? "+" + rest.join(",") : "");
  }
  static kind = "labeled";
  describe(): string {
    return super.describe() + "[" + this.label + "]";
  }
}

class Counted extends Element {
  static made = 0;
  note: string;
  constructor(note?: string) {
    super();
    this.note = note ?? "none";
    Counted.made++;
  }
}

elements.define("x-el", Element);
elements.define("my-field", Field);
elements.define("my-labeled", Labeled);
elements.define("my-counted", Counted);

for (const name of ["x-el", "my-field", "my-labeled", "my-counted"]) {
  const el = elements.create(name);
  console.log(
    name,
    el.describe(),
    el instanceof Element,
    el instanceof Field,
    el instanceof Labeled,
    el.constructor === registry.get(name),
  );
}

console.log(elements.createWith("x-el", "custom").describe());
console.log(elements.createWith("my-labeled", "Name").describe());
console.log((elements.create("my-counted") as Counted).note);
console.log((elements.createWith("my-counted", "noted") as Counted).note);
console.log(Counted.made);

// Statics through the slot read the held class's own.
for (const [name, C] of registry) console.log(name, C.kind, C.name);

// A constructor-type slot with rest parameters, and spread arguments.
type ElementConstructor = new (...params: any[]) => Element;
const ctors: ElementConstructor[] = [Element, Labeled, Field];
const args = ["a", "b", "c"];
for (const C of ctors) console.log(new C(...args).describe());

// The same value through an ancestor's slot.
class Node {
  parent: Node | null;
  constructor(parent: Node | null = null) {
    this.parent = parent;
  }
}
class Item extends Node {
  constructor() {
    super(null);
  }
  name = "item";
}
function build(N: typeof Node): Node {
  return new N();
}
const item = build(Item);
console.log(item instanceof Item, (item as Item).name, item.parent);

// A class value in a field, and a generic constructor parameter.
class Shape {
  size: number;
  constructor(size: number = 1, extra?: number) {
    this.size = size + (extra ?? 0);
  }
  static label = "shape";
}
class Square extends Shape {
  constructor() {
    super(10);
  }
  static label = "square";
}
class Factory {
  ctor: typeof Shape;
  constructor(ctor: typeof Shape) {
    this.ctor = ctor;
  }
  build(): Shape {
    return new this.ctor(2, 3);
  }
}
for (const factory of [new Factory(Shape), new Factory(Square)]) {
  const made = factory.build();
  console.log(made.size, made instanceof factory.ctor, made instanceof Square, factory.ctor.label);
}
function makeAll<T extends Shape>(ctors: (new () => T)[]): T[] {
  return ctors.map((C) => new C());
}
console.log(
  makeAll([Shape, Square])
    .map((shape) => shape.size)
    .join(","),
);
