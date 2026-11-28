// A private-name write through an untyped receiver keeps the brand check.
// The dynamic-write fast path applies to ordinary member names only: a
// `#x` write from a static method whose target parameter is untyped reaches
// the private field of a genuine instance, throws Node's TypeError on a
// wrong brand, and never lands as a public string-key own property.
class Box {
  #secret = 1;

  static writeTo(target, value) {
    target.#secret = value;
  }

  static readFrom(target) {
    return target.#secret;
  }

  readSecret() {
    return this.#secret;
  }
}

const box = new Box();
Box.writeTo(box, 42);
console.log(Box.readFrom(box), box.readSecret());

const outsider = { secret: 1 };
try {
  Box.writeTo(outsider, 7);
} catch (error) {
  console.log(error.name + ": " + error.message);
}
try {
  console.log(Box.readFrom(outsider));
} catch (error) {
  console.log(error.name + ": " + error.message);
}
console.log(Object.keys(outsider).length, outsider.secret);
