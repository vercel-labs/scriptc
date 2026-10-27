// instanceof narrowing downcasts objects to subclasses; the downcast is
// verified against the target's preorder intervals at run time. Covers
// multi-level hierarchies, abstract bases, generic classes, and receivers
// borrowed for field reads as well as owned values passed on.
abstract class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  abstract sound(): string;
}
class Dog extends Animal {
  tricks = ["sit", "roll"];
  sound(): string {
    return "woof";
  }
}
class Puppy extends Dog {
  age = 1;
  sound(): string {
    return "yip";
  }
}
class Cat extends Animal {
  lives = 9;
  sound(): string {
    return "meow";
  }
}

class Box<T> {
  value: T;
  constructor(value: T) {
    this.value = value;
  }
}
class LabeledBox<T> extends Box<T> {
  label: string;
  constructor(value: T, label: string) {
    super(value);
    this.label = label;
  }
}

function describe(a: Animal): string {
  if (a instanceof Puppy) return `${a.name} puppy age ${a.age} ${a.tricks.length} tricks`;
  if (a instanceof Dog) return `${a.name} dog ${a.tricks.join("+")}`;
  if (a instanceof Cat) return `${a.name} cat ${a.lives} lives`;
  return `${a.name} unknown`;
}

function keepDogs(all: Animal[]): Dog[] {
  const dogs: Dog[] = [];
  for (const a of all) if (a instanceof Dog) dogs.push(a);
  return dogs;
}

function labelOf(b: Box<number>): string {
  return b instanceof LabeledBox ? `${b.label}=${b.value}` : `box=${b.value}`;
}

function labelOfText(b: Box<string>): string {
  return b instanceof LabeledBox ? `${b.label}:${b.value}` : `text:${b.value}`;
}

const zoo: Animal[] = [new Dog("rex"), new Cat("tom"), new Puppy("bit"), new Cat("kit")];
for (const a of zoo) console.log(describe(a), a.sound());
console.log(
  "dogs",
  keepDogs(zoo)
    .map((d) => d.name)
    .join(","),
);

let tricks = 0;
for (let round = 0; round < 2000; round++)
  for (const a of zoo) if (a instanceof Dog) tricks += a.tricks.length;
console.log("tricks", tricks);

console.log(labelOf(new Box(1)), labelOf(new LabeledBox(2, "two")));
console.log(labelOfText(new Box("a")), labelOfText(new LabeledBox("b", "bee")));
