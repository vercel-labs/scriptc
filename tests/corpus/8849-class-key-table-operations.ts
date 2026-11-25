// Computed property access on class instances held as `any`, through every
// form the key can arrive in: a string, an untyped value (a string, a number,
// a symbol, an object that converts), a number, and an optional read. Reads,
// writes, `in`, hasOwnProperty, propertyIsEnumerable, Reflect.get and
// Reflect.set answer the same for a member whichever form names it, for
// fields, accessors, methods, inherited members, numeric names and keys no
// member has. A key that converts is converted once per operation.

const tag = Symbol("tag");

class Point {
  x = 1;
  y = 2;
  [tag] = "tagged";
  get label(): string {
    return `(${this.x},${this.y})`;
  }
  get scale(): number {
    return this.x;
  }
  set scale(value: number) {
    this.x *= value;
    this.y *= value;
  }
  norm(): number {
    return Math.abs(this.x) + Math.abs(this.y);
  }
}

class Pixel extends Point {
  color = "red";
  describe(): string {
    return `${this.color}@${this.label}`;
  }
}

class Row {
  0 = "zero";
  1 = "one";
  name = "row";
}

class Empty {}

function show(value: unknown): string {
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return value.toString();
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function attempt(action: () => unknown): string {
  try {
    return show(action());
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

let conversions = 0;
function converting(name: string): any {
  return {
    toString() {
      conversions++;
      return name;
    },
  };
}

// One function per form of the key, so each is its own dispatch shape.
const readString = (value: any, key: string): unknown => value[key];
const readAny = (value: any, key: any): unknown => value[key];
const readNumber = (value: any, key: number): unknown => value[key];
const readOptionalString = (value: any, key: string): unknown => value?.[key];
const readOptionalAny = (value: any, key: any): unknown => value?.[key];
const readOptionalNumber = (value: any, key: number): unknown => value?.[key];
const writeString = (value: any, key: string, stored: unknown): void => {
  value[key] = stored;
};
const writeAny = (value: any, key: any, stored: unknown): void => {
  value[key] = stored;
};
const writeNumber = (value: any, key: number, stored: unknown): void => {
  value[key] = stored;
};
const hasIn = (value: any, key: any): boolean => key in value;
const hasOwn = (value: any, key: any): boolean => Object.prototype.hasOwnProperty.call(value, key);
const enumerable = (value: any, key: any): boolean => value.propertyIsEnumerable(key);
const reflectGet = (value: any, key: any): unknown => Reflect.get(value, key);
const reflectGetFor = (value: any, key: any, receiver: any): unknown =>
  Reflect.get(value, key, receiver);
const reflectSet = (value: any, key: any, stored: unknown): boolean =>
  Reflect.set(value, key, stored);
const reflectSetFor = (value: any, key: any, stored: unknown, receiver: any): boolean =>
  Reflect.set(value, key, stored, receiver);

const names = ["x", "y", "label", "scale", "norm", "color", "describe", "name", "missing", "0", "1"];

function reads(title: string, make: () => any): void {
  console.log(`-- reads: ${title}`);
  const value = make();
  for (const name of names) {
    const row = [
      attempt(() => readString(value, name)),
      attempt(() => readAny(value, name)),
      attempt(() => readOptionalString(value, name)),
      attempt(() => readOptionalAny(value, name)),
      attempt(() => readAny(value, converting(name))),
      attempt(() => reflectGet(value, name)),
      attempt(() => reflectGet(value, converting(name))),
    ];
    console.log(name, row.join(" | "));
  }
  for (const index of [0, 1, 2, -1, 1.5]) {
    console.log(
      index,
      attempt(() => readNumber(value, index)),
      attempt(() => readOptionalNumber(value, index)),
      attempt(() => readAny(value, index)),
      attempt(() => reflectGet(value, index)),
    );
  }
  console.log(
    "symbol",
    attempt(() => readAny(value, tag)),
    attempt(() => readOptionalAny(value, tag)),
    attempt(() => reflectGet(value, tag)),
    attempt(() => readAny(value, Symbol.iterator)),
  );
}

function probes(title: string, make: () => any): void {
  console.log(`-- probes: ${title}`);
  const value = make();
  for (const name of names) {
    console.log(
      name,
      attempt(() => hasIn(value, name)),
      attempt(() => hasOwn(value, name)),
      attempt(() => enumerable(value, name)),
      attempt(() => hasIn(value, converting(name))),
      attempt(() => hasOwn(value, converting(name))),
      attempt(() => enumerable(value, converting(name))),
    );
  }
  for (const index of [0, 1, 2]) {
    console.log(
      index,
      attempt(() => hasIn(value, index)),
      attempt(() => hasOwn(value, index)),
      attempt(() => enumerable(value, index)),
    );
  }
  console.log(
    "symbol",
    attempt(() => hasIn(value, tag)),
    attempt(() => hasOwn(value, tag)),
    attempt(() => enumerable(value, tag)),
  );
}

// What each name stores: a value of the member's own type.
const stored: Record<string, unknown> = {
  x: 3,
  scale: 3,
  color: "blue",
  name: "renamed",
  added: 3,
  "0": "nil",
};

function writes(title: string, make: () => any): void {
  console.log(`-- writes: ${title}`);
  const stores: [string, (value: any, key: string, stored: unknown) => unknown][] = [
    ["string", writeString],
    ["any", writeAny],
    ["converted", (value, key, stored) => writeAny(value, converting(key), stored)],
    ["reflect", reflectSet],
    ["reflect converted", (value, key, stored) => reflectSet(value, converting(key), stored)],
  ];
  for (const [form, store] of stores) {
    for (const name of Object.keys(stored)) {
      const value = make();
      const outcome = attempt(() => store(value, name, stored[name]));
      console.log(form, name, outcome, show(value), attempt(() => readString(value, name)));
    }
  }
  for (const index of [0, 1, 2]) {
    const value = make();
    console.log("number", index, attempt(() => writeNumber(value, index, "n")), show(value));
  }
  const tagged = make();
  console.log(
    "symbol",
    attempt(() => writeAny(tagged, tag, "again")),
    attempt(() => readAny(tagged, tag)),
    attempt(() => reflectSet(tagged, tag, "third")),
    attempt(() => readAny(tagged, tag)),
  );
}

// A getter without a setter refuses the write: a TypeError for an
// assignment, false for Reflect.set.
function getterOnly(): void {
  console.log("-- getter only");
  const point: any = new Point();
  console.log(
    attempt(() => writeString(point, "label", "L")),
    attempt(() => writeAny(point, "label", "L")),
    attempt(() => writeAny(point, converting("label"), "L")),
    attempt(() => reflectSet(point, "label", "L")),
    attempt(() => reflectSet(point, converting("label"), "L")),
    show(point),
  );
}

function receivers(): void {
  console.log("-- receivers");
  const point: any = new Point();
  const other: any = new Pixel();
  other.x = 10;
  other.y = 20;
  const plain: any = { x: 100, y: 200 };
  // A getter runs on the receiver; a data property reads the target.
  console.log(
    attempt(() => reflectGetFor(point, "label", other)),
    attempt(() => reflectGetFor(point, "x", other)),
    attempt(() => reflectGetFor(point, "missing", other)),
  );
  // A setter runs on the receiver; a data property is defined on it.
  console.log(
    attempt(() => reflectSetFor(point, "scale", 2, other)),
    show(point),
    show(other),
  );
  console.log(
    attempt(() => reflectSetFor(point, "x", 7, plain)),
    show(point),
    show(plain),
  );
  console.log(
    attempt(() => reflectSetFor(point, "label", "L", other)),
    attempt(() => reflectSetFor(point, "added", 1, plain)),
    show(point),
    show(plain),
  );
}

const makers: [string, () => any][] = [
  ["Point", () => new Point()],
  ["Pixel", () => new Pixel()],
  ["Row", () => new Row()],
  ["Empty", () => new Empty()],
  ["plain object", () => ({ x: 5, name: "plain" })],
  ["array", () => ["a", "b"]],
];

for (const [title, make] of makers) reads(title, make);
for (const [title, make] of makers) probes(title, make);
for (const [title, make] of makers) writes(title, make);
getterOnly();
receivers();
// Each operation above converted its key once.
console.log("conversions", conversions);
console.log(attempt(() => readString(null, "x")), attempt(() => readOptionalString(null, "x")));
console.log(attempt(() => readAny(undefined, "x")), attempt(() => readOptionalAny(undefined, "x")));
console.log(attempt(() => writeString(null, "x", 1)), attempt(() => hasIn(null, "x")));
