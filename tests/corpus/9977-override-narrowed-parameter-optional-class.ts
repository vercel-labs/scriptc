// An override that requires a parameter its base declares optional (or declares it without
// `undefined`), and one that declares a subclass of the inherited class. Every call here passes a
// value the override declares.
class Base {
  greet(name?: string): string {
    return `base ${name ?? "nobody"}`;
  }
  twice(n: number | undefined): number {
    return (n ?? 0) * 2;
  }
}
class Sub extends Base {
  greet(name: string): string {
    return `sub ${name.length}`;
  }
  twice(n: number): number {
    return n * 20;
  }
}
class Animal {
  name = "animal";
  feed(other: Animal): string {
    return `${this.name} feeds ${other.name}`;
  }
}
class Dog extends Animal {
  name = "dog";
  breed = "lab";
  feed(other: Dog): string {
    return `${this.name} feeds ${other.breed}`;
  }
}
class Puppy extends Dog {
  breed = "pup";
}
const sub = new Sub();
const asBase: Base = sub;
const untyped: any = sub;
console.log(sub.greet("abc"), asBase.greet("abcd"), untyped.greet("ab"));
console.log(sub.twice(2), asBase.twice(3), new Base().greet(), new Base().twice(undefined));
const dog = new Dog();
const asAnimal: Animal = dog;
const anyDog: any = dog;
console.log(dog.feed(new Dog()), dog.feed(new Puppy()), asAnimal.feed(new Dog()));
console.log(asAnimal.feed(new Puppy()), anyDog.feed(new Dog()), new Animal().feed(new Animal()));
const pack: Animal[] = [new Animal(), dog, new Puppy()];
console.log(pack.map((each) => each.feed(new Puppy())).join(" | "));
