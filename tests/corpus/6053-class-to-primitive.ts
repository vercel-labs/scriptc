// String and number conversions of class instances run Node's ToPrimitive
// protocol through the class's own methods: String(x) and template
// literals use the string hint, `+` with a string the default hint, and
// Number(x) and unary plus the number hint. Classes without conversion
// methods convert to "[object Object]" and NaN.
class Money {
  cents: number;
  constructor(cents: number) {
    this.cents = cents;
  }
  toString(): string {
    return `$${(this.cents / 100).toFixed(2)}`;
  }
  valueOf(): number {
    return this.cents;
  }
}
const m = new Money(1250);
console.log(String(m), `${m}`, "total " + m, m + "!");
let s = "sum:";
s += m;
console.log(s);
class Plain {
  x = 1;
}
console.log(String(new Plain()), `${new Plain()}`, "p" + new Plain());
class Base {
  name(): string {
    return "base";
  }
}
class Named extends Base {
  toString(): string {
    return "named " + this.name();
  }
}
class Deeper extends Named {
  valueOf(): number {
    return 7;
  }
}
const items: Base[] = [new Base(), new Named(), new Deeper()];
for (const item of items) console.log(String(item), `${item}`, "+" + item);
class Hinted {
  [Symbol.toPrimitive](hint: string): string | number {
    return hint === "number" ? 42 : `hint:${hint}`;
  }
}
const h = new Hinted();
console.log(String(h), `${h}`, "x" + h);
let calls = 0;
class Counted {
  toString(): string {
    calls++;
    return "c" + calls;
  }
}
const c = new Counted();
console.log(`${c}-${c}`, calls);

class Amount {
  cents: number;
  constructor(cents: number) {
    this.cents = cents;
  }
  valueOf(): number {
    return this.cents;
  }
}
const amount = new Amount(1250);
console.log(Number(amount), +amount);
class Label {
  toString(): string {
    return "12.5";
  }
}
class Flag {
  [Symbol.toPrimitive](hint: string): number | string {
    return hint === "number" ? 3 : "flag";
  }
}
class Empty {}
console.log(Number(new Label()), +new Label(), Number(new Flag()), +new Flag(), `${new Flag()}`, Number(new Empty()));

class Box<T> {
  value: T;
  constructor(value: T) {
    this.value = value;
  }
  toString(): string {
    return `Box(${String(this.value)})`;
  }
  describe(): string {
    return `I am ${this}`;
  }
}
console.log(`${new Box(1)}`, String(new Box("s")), new Box(true).describe());
abstract class Shape {
  abstract area(): number;
  toString(): string {
    return `shape:${this.area()}`;
  }
}
class Square extends Shape {
  side: number;
  constructor(side: number) {
    super();
    this.side = side;
  }
  area(): number {
    return this.side * this.side;
  }
}
const shapes: Shape[] = [new Square(3)];
console.log(shapes.map((shape) => `${shape}`).join(","));
class Code {
  valueOf(): string {
    return "code-value";
  }
}
console.log(String(new Code()), "" + new Code());
const maybe: Box<number> | undefined = process.argv.length > 99 ? undefined : new Box(5);
console.log(`${maybe}`);
const pair: Code | number | null = process.argv.length > 99 ? null : new Code();
console.log(`${pair}`, "p:" + pair);
