class Box {
  constructor(v) {
    this.v = v;
  }
}
const b = new Box(1);
console.log(b);
b.extra = "e";
console.log(b);

class Plain {}
const q = new Plain();
console.log(q);
q.a = 1;
q.b = [1, 2];
console.log(q);
q.nested = new Box(2);
console.log(q);
console.log([q]);

class Late {
  constructor() {
    this.a = 1;
  }
  setB() {
    this.b = 2;
  }
}
const late = new Late();
console.log(late);
late.setB();
console.log(late);

class Cond {
  constructor(flag) {
    if (flag) this.x = 1;
    this.y = 2;
  }
}
console.log(new Cond(true), new Cond(false));
