// Class instances held in unions with their base class: an array of
// `Shape | Circle | Rect` scanned for areas, a map of `Account | Savings`
// values updated through methods that return `this`, and `instanceof`
// tests that select the subclass members. Argument: the number of rounds.
const rounds = Number(process.argv[2] ?? "200");

class Shape {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  area(): number {
    return 0;
  }
  moveBy(dx: number, dy: number): this {
    this.x += dx;
    this.y += dy;
    return this;
  }
}
class Circle extends Shape {
  r: number;
  constructor(x: number, y: number, r: number) {
    super(x, y);
    this.r = r;
  }
  area(): number {
    return 3 * this.r * this.r;
  }
}
class Rect extends Shape {
  w: number;
  h: number;
  constructor(x: number, y: number, w: number, h: number) {
    super(x, y);
    this.w = w;
    this.h = h;
  }
  area(): number {
    return this.w * this.h;
  }
}

class Account {
  id: string;
  balance: number;
  constructor(id: string, balance: number) {
    this.id = id;
    this.balance = balance;
  }
  deposit(amount: number): this {
    this.balance += amount;
    return this;
  }
}
class Savings extends Account {
  rate: number;
  constructor(id: string, balance: number, rate: number) {
    super(id, balance);
    this.rate = rate;
  }
  accrue(): void {
    this.balance += Math.floor((this.balance * this.rate) / 1000);
  }
}

const shapes: Array<Shape | Circle | Rect> = [];
for (let i = 0; i < 4096; i++) {
  const k = i % 3;
  shapes.push(
    k === 0
      ? new Circle(i % 50, i % 70, 1 + (i % 9))
      : k === 1
        ? new Rect(i % 30, i % 40, 1 + (i % 7), 1 + (i % 5))
        : new Shape(i % 20, i % 10),
  );
}
const accounts = new Map<string, Account | Savings>();
for (let i = 0; i < 512; i++) {
  const id = `acct-${i}`;
  accounts.set(id, i % 4 === 0 ? new Savings(id, 1000 + i, 1 + (i % 3)) : new Account(id, i));
}
const ids = [...accounts.keys()];

let total = 0;
let circles = 0;
let wide = 0;
for (let r = 0; r < rounds; r++) {
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i]!;
    const moved = s.moveBy((r + i) % 3 - 1, (r * i) % 5 - 2);
    total += moved.area() + moved.x - moved.y;
    if (s instanceof Circle) circles += s.r;
    else if (s instanceof Rect && s.w > s.h) wide++;
    if (s.x > 1000 || s.x < -1000) s.x = 0;
    if (s.y > 1000 || s.y < -1000) s.y = 0;
  }
  for (let i = 0; i < ids.length; i++) {
    const a = accounts.get(ids[(i * 7 + r) % ids.length]!)!;
    a.deposit((i + r) % 11);
    if (a instanceof Savings && (r & 15) === 0) a.accrue();
  }
}
let balances = 0;
for (const a of accounts.values()) balances += a.balance;
const last = shapes[shapes.length - 1]!;
console.log(total, circles, wide, balances, last.x, last.y, last instanceof Rect ? last.w : -1);
