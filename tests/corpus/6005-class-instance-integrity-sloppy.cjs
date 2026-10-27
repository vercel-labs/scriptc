class Box {
  constructor() {
    this.x = 1;
  }
  bump() {
    this.x = 2;
  }
}

const b = new Box();
Object.freeze(b);
b.x = 5;
console.log(b.x, Object.isFrozen(b));

function strictWrite() {
  "use strict";
  try {
    b.x = 6;
  } catch (e) {
    console.log(e instanceof TypeError, e.message);
  }
}
strictWrite();

try {
  b.bump();
} catch (e) {
  console.log("class body:", e.message);
}
console.log(b.x);

const s = new Box();
Object.seal(s);
s.x = 3;
console.log(s.x, Object.isSealed(s), Object.isFrozen(s));

const plain = new Box();
Object.defineProperty(plain, "x", { writable: false });
plain.x = 9;
console.log(plain.x, JSON.stringify(Object.getOwnPropertyDescriptor(plain, "x")));
