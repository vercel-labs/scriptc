// Overrides declared by function-local subclasses in JavaScript dispatch on
// the receiver when the call site lowers before the declaring function.
class Animal {
  constructor(name) {
    this.name = name;
  }
  speak() {
    return this.name + " makes a sound";
  }
}

function dog(name) {
  class Dog extends Animal {
    speak() {
      return this.name + " barks";
    }
  }
  return new Dog(name);
}

function animals() {
  class Bird extends Animal {
    speak() {
      return this.name + " sings";
    }
  }
  return [new Animal("cat"), new Bird("robin"), dog("rex")];
}

for (const animal of animals()) console.log(animal.speak());
const speak = (animal) => animal.speak();
console.log(speak(dog("fido")));

function pets() {
  class Pet {
    constructor(name) {
      this.name = name;
    }
    greet() {
      return this.name + " waves";
    }
  }
  class Cat extends Pet {
    greet() {
      return this.name + " purrs";
    }
  }
  return [new Pet("ann"), new Cat("tom")];
}
const [pet, cat] = pets();
console.log(pet.greet(), cat.greet());
