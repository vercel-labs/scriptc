// A descriptor read on a class's prototype through an untyped reader (a
// UI SDK's value interceptor) answers what Node answers: the accessor pair
// the class declares, with its attributes, and the same functions the class
// itself holds. The reader's parameter is `any`, so the prototype comes from
// the value's run-time class, and the class's statics are reflected through
// its class value at the same time.
class Field {
  #value = "x";
  get value(): string {
    return this.#value;
  }
  set value(next: string) {
    this.#value = next;
  }
  static make(name: string, extra?: string): string {
    return name + (extra === undefined ? "!" : extra);
  }
}

function read(el: any) {
  return Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
}

const field = new Field();
const descriptor = read(field)!;
console.log(
  typeof descriptor.get,
  typeof descriptor.set,
  descriptor.enumerable,
  descriptor.configurable,
);
console.log(descriptor.get!.call(field));
descriptor.set!.call(field, "next");
console.log(field.value);

// The class value's own descriptor is the static Node defines, and calling it
// through a stored value completes an omitted argument like a direct call.
const make = (Object.getOwnPropertyDescriptor(Field as any, "make") as any).value;
console.log(make("a"), make("a", "b"), Field.make("c"));

// A key the prototype does not declare answers no descriptor at all.
const absent = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "missing");
console.log(absent === undefined, descriptor.value === undefined);
