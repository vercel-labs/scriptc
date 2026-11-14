// Converting class instances to primitives in a program that writes
// properties under computed keys: an instance converts through its declared
// methods until a write gives it an own conversion method or the program
// changes a prototype's, and through the replacement after that, as in
// Node.

class Token {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  toString(): string {
    return "token:" + this.text;
  }
}
class Plain {
  v = 1;
}
class Bag {
  [key: string]: any;
  n = 0;
}
class Store {
  put(key: string, value: number): void {
    (this as any)[key] = value;
  }
  define(key: string, value: unknown): void {
    Object.defineProperty(this, key, { value, enumerable: true, configurable: true, writable: true });
  }
}
class Shape {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  toString(): string {
    return "shape " + this.name;
  }
}
class Circle extends Shape {
  toString(): string {
    return "circle " + this.name;
  }
}
class Square extends Shape {}

function put(target: any, key: string, value: unknown): void {
  target[key] = value;
}

// Computed writes on other instances leave these conversions alone.
const bag = new Bag();
const key = "a" + 1;
bag[key] = 7;
const store = new Store();
store.put("q" + 2, 3);
store.define("d", 4);
const t = new Token("a");
const u = new Token("b");
const p = new Plain();
console.log("before", "" + t, String(u), `${p}`, Number(p), bag[key], String(bag), `${store}`);

// A write that gives an instance its own conversion method.
const q = new Plain();
put(t, "toString", () => "own");
put(p, "toString", () => "plain-own");
put(q, "valueOf", () => 42);
console.log("own", "" + t, String(t), `${u}`, "" + p, String(p), "" + q, Number(q), String(q));

// A replacement that answers a BigInt: Number() converts it, and unary
// plus throws.
const big = new Plain();
put(big, "valueOf", () => 10n);
console.log("bigint", Number(big), String(big));
try {
  console.log(+big);
} catch (error) {
  console.log("unary plus:", error instanceof TypeError, (error as Error).message);
}

// A subclass's override, an inherited method, then a prototype change.
const shapes: Shape[] = [new Shape("s"), new Circle("c"), new Square("q")];
console.log(shapes.map((shape) => "" + shape).join(" | "));
(Shape.prototype as any).toString = function (this: Shape): string {
  return "patched " + this.name;
};
console.log(shapes.map((shape) => `${shape}`).join(" | "), String(new Square("late")));
