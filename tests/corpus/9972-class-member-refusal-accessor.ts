// An accessor half that is refused (its type differs from its twin's, or from the inherited
// accessor's) does not reject its class: the other half, the fields and the methods work. The
// refused halves are never used here.
class Cell {
  private raw = "1";
  n = 1;
  get v(): string {
    return this.raw;
  }
  set v(x: string | number) {
    this.raw = String(x);
  }
  bump(): number {
    this.raw = String(++this.n);
    return this.n;
  }
}
class Animal {
  tag = "animal";
}
class Dog extends Animal {
  breed = "lab";
}
class Kennel {
  held: Animal = new Animal();
  get pet(): Animal {
    return this.held;
  }
  size(): number {
    return 1;
  }
}
class DogKennel extends Kennel {
  get pet(): Dog {
    return new Dog();
  }
  size(): number {
    return 2;
  }
}
const c = new Cell();
console.log(c.v, c.bump(), c.v, c instanceof Cell);
const kennels: Kennel[] = [new Kennel(), new DogKennel()];
console.log(kennels.map((k) => k.size()).join(","), kennels[0]!.pet.tag);
console.log(kennels[1] instanceof DogKennel, kennels[1]!.held.tag);
