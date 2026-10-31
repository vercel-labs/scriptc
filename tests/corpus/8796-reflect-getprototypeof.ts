// Reflect.getPrototypeOf over a class instance: the same prototype edge
// Object.getPrototypeOf answers — every instance of a class shares its
// class's prototype object, and two classes answer different ones.
class Thing {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  greet(): string {
    return "hi " + this.label;
  }
}

class Other {}

const a = new Thing("a");
const b = new Thing("b");
const proto = Reflect.getPrototypeOf(a);
console.log("shared", Reflect.getPrototypeOf(a) === Reflect.getPrototypeOf(b));
console.log("object-same", Object.getPrototypeOf(a) === proto);
console.log("classes", proto === Reflect.getPrototypeOf(new Other()));
console.log("type", typeof proto);
console.log("greet", proto === Reflect.getPrototypeOf(a) ? a.greet() : "?");
