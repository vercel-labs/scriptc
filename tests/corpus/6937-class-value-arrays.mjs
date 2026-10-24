// Arrays of class values that mix a base class and its subclasses: the
// elements construct, compare and name like the classes themselves.
class Animal {
  speak() {
    return "...";
  }
}
class Dog extends Animal {
  speak() {
    return "woof";
  }
}
class Cat extends Animal {
  speak() {
    return "meow";
  }
}
const kinds = [Dog, Cat, Animal];
console.log(kinds.length, kinds.map((C) => C.name).join());
console.log(new kinds[0]().speak(), new kinds[1]().speak(), new kinds[2]().speak());
console.log(kinds[0] === Dog, kinds.indexOf(Cat), kinds.includes(Animal));
const made = kinds.map((C) => new C());
console.log(made.map((a) => a.speak()).join(), made[0] instanceof Animal, made[1] instanceof Dog);
try {
  new kinds[5]();
} catch (e) {
  console.log(e.name, e.message);
}
const byName = { dog: Dog, cat: Cat };
console.log(new byName.dog().speak(), new byName["cat"]().speak());
