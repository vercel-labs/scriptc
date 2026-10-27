// `instanceof` against builtin constructors held as values, with instances of
// program classes and native values on the left.
class Dog {
  constructor(name) {
    this.name = name;
  }
}
class Puppy extends Dog {}
const kinds = [Map, Set, RegExp, Promise, WeakMap, WeakSet, Date];
const values = [];
values.push(new Dog("rex"), new Puppy("bit"), new Map(), new Set(), /x/g, Promise.resolve(1));
values.push(new WeakMap(), new WeakSet(), new Date(0), { name: "plain" }, [1, 2]);
for (const C of kinds) console.log(C.name, values.map((v) => (v instanceof C ? 1 : 0)).join(""));
