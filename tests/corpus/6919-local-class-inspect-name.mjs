// console.log prints instances of function-local classes with prototype
// methods under their class names.
function point() {
  class Point {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }
    plus(other) {
      return new Point(this.x + other.x, this.y + other.y);
    }
  }
  return Point;
}
const Point = point();
const a = new Point(1, 2);
console.log(a, a.plus(a));
console.log([new Point(0, 0)], { p: new Point(5, 6) });

function animals() {
  class Animal {
    constructor(name) {
      this.name = name;
    }
    speak() {
      return this.name + " makes a sound";
    }
  }
  class Dog extends Animal {
    speak() {
      return this.name + " barks";
    }
  }
  return [new Animal("cat"), new Dog("rex")];
}
const [cat, dog] = animals();
console.log(cat, dog);

function anonymous() {
  const Named = class {
    value() {
      return 1;
    }
  };
  return [new Named(), new (class {
    value() {
      return 2;
    }
  })()];
}
console.log(anonymous());
