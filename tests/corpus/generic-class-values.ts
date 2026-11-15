// A generic class taken as a value (`{ Box }`, a field initialized with the
// class, a `typeof Box` parameter, an `any` binding): the one class
// JavaScript holds for every type argument, constructed with nothing to
// infer, as in Node.
class Box<T> {
  value: T | null = null;
  put(v: T): this {
    this.value = v;
    return this;
  }
  static make(): string {
    return "made";
  }
}
const registry: any = { Box };
console.log(typeof registry.Box, registry.Box.name, registry.Box === Box);
const fromRegistry = new registry.Box();
fromRegistry.put(5);
console.log(fromRegistry.value, fromRegistry instanceof Box, Box.make());

class CustomEvent<T = any> {
  detail: T | null = null;
  type: string;
  constructor(type: string) {
    this.type = type;
  }
}
class Window {
  readonly CustomEvent = CustomEvent;
}
const w = new Window();
const event = new w.CustomEvent("ping");
event.detail = { n: 1 };
console.log(typeof w.CustomEvent, event.type, event instanceof CustomEvent, w.CustomEvent === CustomEvent);

function make(C: typeof Box): Box<unknown> {
  return new C();
}
console.log(make(Box).put("x").value);

class Named {
  name = "n";
}
class Holder<T extends Named> {
  item: T | null = null;
  show(): string {
    return this.item === null ? "none" : this.item.name;
  }
}
const H: any = Holder;
const h = new H();
console.log(h.show());
h.item = new Named();
console.log(h.show());

// One class in JavaScript: an instance of any instantiation, or of a
// subclass of one, is an instance of the class value.
class Shelf extends Box<string> {}
const anyBox: any = Box;
const numbers = new Box<number>().put(1);
console.log(numbers instanceof anyBox, new Shelf() instanceof anyBox, new Named() instanceof anyBox);
const typedBox: typeof Box = Box;
console.log(numbers instanceof typedBox, new Shelf() instanceof registry.Box, h instanceof registry.Box);
