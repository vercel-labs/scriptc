class Box {
  constructor(v) {
    this.v = v;
  }
}

class Plain {}

class Late {
  constructor() {
    this.a = 1;
  }
  setB() {
    this.b = 2;
  }
  toString() {
    return "late";
  }
}

class Shaped {
  constructor(n) {
    this.n = n;
  }
  toJSON() {
    return { shaped: this.n };
  }
}

const b = new Box(1);
console.log(JSON.stringify(b));
b.extra = "e";
console.log(JSON.stringify(b));

const q = new Plain();
console.log(JSON.stringify(q));
q.a = 1;
q.inner = new Box(2);
q.list = [new Box(3), null];
console.log(JSON.stringify(q));
console.log(JSON.stringify([q, b], null, 1));

const late = new Late();
console.log(JSON.stringify(late));
late.c = 3;
late.setB();
console.log(JSON.stringify(late));

console.log(JSON.stringify({ s: new Shaped(4), arr: [new Shaped(5)] }));
