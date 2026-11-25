// A function held at a narrower function type inside a container, a
// generic, a union, a class field or a promise, then called at a wider
// type: the function still receives every argument of the final call.
function label(prefix: string, options?: { upper: boolean }): string {
  return options?.upper ? prefix.toUpperCase() : prefix;
}
type One = (prefix: string) => string;
type Two = (prefix: string, options: { upper: boolean }) => string;
function narrowOf(f: One): One {
  return f;
}
const up = { upper: true };

// Generic parameters.
function same<T>(x: T): T {
  return x;
}
function apply2<A, B, R>(f: (a: A, b: B) => R, a: A, b: B): R {
  return f(a, b);
}
function holder<F extends One>(f: F): F {
  return f;
}
const viaSame: Two = same(narrowOf(label));
const viaHolder: Two = holder(narrowOf(label));
console.log("generic", viaSame("abc", up), apply2(narrowOf(label), "abc", up), viaHolder("abc", up));

// Array, Map and tuple elements, a spread record, a destructured field, a
// record converted to a record whose field takes more.
const list: One[] = [label];
const fromList: Two = list[0]!;
const wides: Two[] = [];
for (const f of list) wides.push(f);
const table = new Map<string, One>([["k", label]]);
const fromMap: Two = table.get("k")!;
const pair: [One, number] = [label, 1];
const fromTuple: Two = pair[0];
const base: { make: One } = { make: label };
const copy = { ...base, extra: 1 };
const fromSpread: Two = copy.make;
const { make } = base;
const fromDestructure: Two = make;
const wideRecord: { make: Two } = base;
console.log(
  "containers",
  fromList("a", up),
  wides[0]!("b", up),
  fromMap("c", up),
  fromTuple("d", up),
  fromSpread("e", up),
  fromDestructure("f", up),
  wideRecord.make("g", up),
);

// An optional field, a union of two function types, a function or
// undefined, a function or a string.
interface Ops {
  make?: One;
}
const ops: Ops = { make: label };
const made = ops.make;
if (made !== undefined) {
  const wide: Two = made;
  console.log("optional", wide("abc", up));
}
const maybeWide: Two | undefined = ops.make;
console.log("optional", maybeWide?.("abc", up));
const either: One | Two = narrowOf(label);
const fromEither: Two = either;
function maybe(f: One | undefined): Two | undefined {
  return f;
}
function orText(f: One | string): string {
  if (typeof f === "string") return f;
  const wide: Two = f;
  return wide("abc", up);
}
console.log("union", fromEither("abc", up), maybe(label)?.("abc", up), maybe(undefined) === undefined);
console.log("union", orText(label), orText(narrowOf(label)), orText("text"));

// A class field slot and a promise payload.
class Box {
  make: One;
  constructor(make: One) {
    this.make = make;
  }
}
class WideBox {
  make: Two;
  constructor(make: Two) {
    this.make = make;
  }
}
const wideBox = new WideBox(new Box(label).make);
const later: Promise<One> = Promise.resolve(narrowOf(label));
const awaited: Two = await later;
console.log("class", wideBox.make("abc", up), "promise", awaited("abc", up));
