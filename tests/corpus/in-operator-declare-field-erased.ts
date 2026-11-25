// A `declare` field is erased: the class emits no field for it, so an
// instance only has the name when something else put a value there.
class Erased {
  declare value: number;
  method(): string {
    return "m";
  }
}
const erased = new Erased();
console.log("erased:", "value" in erased, "method" in erased, "nope" in erased);
const view: any = erased;
view.value = 5;
console.log("filled:", "value" in erased, erased.value);

// A field the class declares without an initializer is still created (with
// undefined), and an initializer that reads a declared field sees it.
class Slots {
  empty: number | undefined;
  first = "second" in this;
  second = 2;
}
const slots = new Slots();
console.log("slots:", "empty" in slots, slots.first, "second" in slots);
