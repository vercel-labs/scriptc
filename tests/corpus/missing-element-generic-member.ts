// A missing array element passed where a generic member of a class declares
// a bare type parameter reaches the instance as `undefined`, as it does
// through a generic function: methods, static methods, private members,
// fields that hold a generic function, members of a generic class, and the
// calls through `this`, `super` and `?.`.
interface Point {
  x: number;
}

class Keeper {
  calls = 0;
  keep<U>(v: U): U {
    this.calls++;
    return v;
  }
  orElse<U>(v: U, fallback: U): U {
    return v === undefined ? fallback : v;
  }
  show<U>(v: U): string {
    return String(v);
  }
  isMissing<U>(v: U): boolean {
    return v === undefined;
  }
  twice<U>(v: U): U {
    return this.keep(this.keep(v));
  }
  held = <U,>(v: U): U => v;
  #hidden<U>(v: U): U {
    return v;
  }
  viaHidden(values: number[], i: number): boolean {
    return this.#hidden(values[i]) === undefined;
  }
  static keep<U>(v: U): U {
    return v;
  }
  static #hiddenStatic<U>(v: U): U {
    return v;
  }
  static viaThis(names: string[], i: number): boolean {
    return this.keep(names[i]) === undefined;
  }
  static viaHidden(names: string[], i: number): boolean {
    return Keeper.#hiddenStatic(names[i]) === undefined;
  }
}

class Derived extends Keeper {
  viaSuper(values: number[], i: number): boolean {
    return super.keep(values[i]) === undefined;
  }
  viaThis(values: number[], i: number): boolean {
    return this.keep(values[i]) === undefined;
  }
}

class Box<T> {
  value: T;
  constructor(value: T) {
    this.value = value;
  }
  get(): T {
    return this.value;
  }
  keep<U>(v: U): U {
    return v;
  }
  keepBeside<U>(v: U, other: Box<T>): U {
    return other.get() === this.value ? v : v;
  }
  inside(values: number[], other: Box<T>): boolean {
    return this.keepBeside(values[9], other) === undefined;
  }
}

const values: number[] = [1, 2];
const names: string[] = ["n"];
const flags: boolean[] = [true];
const points: Point[] = [{ x: 1 }];
const k = new Keeper();

// Methods, with the present element beside the missing one.
console.log(k.keep(values[20]) === undefined, k.keep(names[9]) === undefined);
console.log(k.keep(values[1]), k.keep(names[0]), k.keep(flags[0]), k.keep(points[0]));
console.log(k.keep(flags[3]) === undefined, k.keep(points[4]) === undefined, k.calls);

// The result is the argument's value wherever it goes.
const stored = k.keep(values[20]);
const present = k.keep(values[0]);
console.log(stored === undefined, typeof stored, String(stored), present, typeof present);
const annotated: string = k.keep(names[4]);
console.log(annotated === undefined, typeof annotated);
console.log(k.orElse(values[5], 7), k.orElse(values[0], 7), k.orElse(names[2], "d"));
console.log(k.show(values[9]), k.show(names[0]), k.isMissing(points[9]), k.isMissing(points[0]));
console.log(k.twice(values[20]) === undefined, k.twice(values[1]));
console.log(k.keep(k.keep(names[6])) === undefined, k.keep(k.keep(names[0])));
console.log([k.keep(values[20])].length, `${k.keep(values[20])}`);

// A type argument the call spells out.
console.log(k.keep<number>(values[20]) === undefined, k.keep<number>(values[1]));

// A field that holds a generic function, and private members.
console.log(k.held(values[20]) === undefined, k.held(names[9]) === undefined, k.held(values[1]));
console.log(k.viaHidden(values, 20), k.viaHidden(values, 0));

// Static members, through the class name and through `this`.
console.log(Keeper.keep(values[20]) === undefined, Keeper.keep(names[9]) === undefined);
console.log(Keeper.keep(values[1]), Keeper.viaThis(names, 9), Keeper.viaThis(names, 0));
console.log(Keeper.viaHidden(names, 9), Keeper.viaHidden(names, 0));

// An inherited member, through the subclass, `super` and `this`.
const d = new Derived();
console.log(d.keep(values[20]) === undefined, d.keep(values[0]));
console.log(d.viaSuper(values, 20), d.viaSuper(values, 0), d.viaThis(values, 20), d.viaThis(values, 0));

// An optional call.
const maybe: Keeper | undefined = values.length > 1 ? new Keeper() : undefined;
const none: Keeper | undefined = values.length > 5 ? new Keeper() : undefined;
console.log(maybe?.keep(values[20]) === undefined, maybe?.keep(values[1]));
console.log(none?.keep(values[20]) === undefined, none?.keep(values[1]) === undefined);

// Members of a generic class, one of them beside a parameter of the class's
// own type.
const a = new Box("a");
const b = new Box("b");
const n = new Box(3);
console.log(a.keep(values[20]) === undefined, a.keep(names[9]) === undefined, a.keep(values[1]));
console.log(a.keepBeside(values[20], b) === undefined, a.keepBeside(values[1], b));
console.log(a.inside(values, b), n.inside(values, n), n.keepBeside(names[0], n));

// Inside a function, over a local array.
function inFunction(): void {
  const local: boolean[] = [];
  const keeper = new Keeper();
  const q = keeper.keep(local[0]);
  console.log(q === undefined, keeper.calls);
  const out: (number | undefined)[] = [];
  for (let i = 0; i < 4; i++) out.push(keeper.keep(values[i]));
  console.log(out.length, out[2] === undefined, out[3] === undefined, out[1]);
}
inFunction();

// A callback, and a loop the bound proves in range.
const indices = [0, 5];
console.log(indices.map((i) => k.keep(values[i]) === undefined).join(","));
let sum = 0;
for (let i = 0; i < values.length; i++) sum += k.keep(values[i]);
console.log(sum);
