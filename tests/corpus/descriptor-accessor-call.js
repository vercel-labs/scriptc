// A property descriptor's get and set are ordinary functions: the standard wrapper for a native accessor reads them from the prototype and calls them with another receiver. Node binds whatever receiver `.call`/`.apply` names, including an instance of a subclass, and a wrong receiver fails inside the accessor body (a private field brands it).
class Field {
  #value = "";
  get value() { return this.#value; }
  set value(next) { this.#value = next; }
}

class PasswordField extends Field {}

function wrap(el) {
  const base = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
  return {
    read() { return base.get.call(el); },
    write(next) { base.set.call(el, next); },
  };
}

const field = new Field();
field.value = "first";
const wrapped = wrap(field);
wrapped.write("second");
console.log(wrapped.read(), field.value);

const password = new PasswordField();
const shared = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value");
shared.set.call(password, "secret");
console.log(shared.get.call(password), password.value, password instanceof Field);

const get = shared.get;
const set = shared.set;
set.apply(field, ["third"]);
console.log(get.apply(field, []), field.value, Reflect.apply(get, password, []));

const plain = {};
for (const call of [() => get.call(plain), () => set.call(plain, "x")]) {
  try {
    call();
  } catch (error) {
    console.log(error.constructor.name, error.message);
  }
}

// An accessor over a public field runs against whatever receiver it is given.
class Counted {
  count = 1;
  get total() { return this.count; }
  set total(next) { this.count = next; }
}
const counted = new Counted();
const total = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(counted), "total");
const loose = { count: 5 };
console.log(total.get.call(loose));
total.set.call(loose, 7);
console.log(loose.count, counted.count);

// A key the prototype does not declare answers no descriptor at all.
const absent = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "missing");
try {
  absent.get.call(field);
} catch (error) {
  console.log(error.constructor.name, error.message);
}
