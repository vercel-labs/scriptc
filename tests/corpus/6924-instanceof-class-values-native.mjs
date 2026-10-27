// `instanceof` against program classes held as values, with native builtin
// values on the left: their prototype chains hold no program class.
class Animal {
  constructor(name) {
    this.name = name;
  }
}
class Dog extends Animal {}
class Cat extends Animal {}
const classes = { Animal: Animal, Dog: Dog, Cat: Cat };
const values = [];
values.push(new Map(), new Set(), /x/, Promise.resolve(1), new Date(0), new WeakMap(), new WeakSet());
values.push(new Dog("rex"), new Cat("tom"), new Animal("any"), {}, [], null);
for (const name of Object.keys(classes)) {
  const C = classes[name];
  console.log(name, values.map((v) => (v instanceof C ? 1 : 0)).join(""));
}
const holder = { type: Dog };
console.log(new Map() instanceof holder.type, new Dog("a") instanceof holder.type);
