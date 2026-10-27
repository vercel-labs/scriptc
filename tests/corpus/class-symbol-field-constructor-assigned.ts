// Symbol-keyed (and literal-keyed) TypeScript fields without an
// initializer take their declared type when the constructor assigns them
// unconditionally; an optional one starts undefined. A field assigned
// later (here from a method the constructor calls) reads through the
// checked deferred-initialization slot.
const Internal = Symbol("internal");
const Registered = Symbol.for("pkg.registered");
const Pending = Symbol("pending");

class Box {
  [Internal]: { n: number };
  [Registered]: string[];
  ["literal"]: number;
  [Pending]?: string[];
  constructor(n: number) {
    this[Internal] = { n };
    this[Registered] = ["a"];
    this["literal"] = n * 2;
  }
  get n(): number {
    return this[Internal].n;
  }
}

const b = new Box(5);
console.log(b.n, b[Registered].length, b.literal, b[Pending] === undefined);
b[Internal].n = 7;
b[Registered].push("b");
b[Pending] = ["p"];
console.log(b.n, b[Registered].join(","), b[Pending]?.join(","));
console.log(JSON.stringify(Object.entries({ literal: b.literal })));

class Late {
  [Internal]!: { n: number };
  constructor(flag: boolean) {
    if (flag) this[Internal] = { n: 1 };
    else this.init();
  }
  init(): void {
    this[Internal] = { n: 2 };
  }
}
console.log(new Late(true)[Internal].n, new Late(false)[Internal].n);
