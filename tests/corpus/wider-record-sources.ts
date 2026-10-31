// An object with more properties than its static record type: the record
// keeps the other properties of the object it was converted from, so
// string conversion, Object.keys, for...in, `in`, the own-key tests,
// JSON.stringify and util.inspect answer as for that object.
type Plain = { a: number };
type Point = { x: number; y: number };
type Labeled = { label: string; size?: number };

let calls = 0;
const wide = {
  a: 1,
  extra: "x",
  nested: { deep: true },
  list: [1, 2],
  toString() {
    calls++;
    return "wide";
  },
  valueOf() {
    return 42;
  },
};
const asPlain: Plain = wide;
const box: unknown = asPlain;

console.log(String(box), `${asPlain}`, String(asPlain), "" + asPlain, calls);
console.log(asPlain.toString(), asPlain.toLocaleString(), calls);
console.log(Object.keys(asPlain).join(","), JSON.stringify(asPlain));
console.log(asPlain.hasOwnProperty("extra"), asPlain.hasOwnProperty("toString"), Object.hasOwn(asPlain, "list"));
console.log(asPlain.propertyIsEnumerable("extra"), "extra" in asPlain, "missing" in asPlain, "toString" in asPlain);
const keys: string[] = [];
for (const k in asPlain) keys.push(k);
console.log(keys.join(","));
const plains: Record<string, (key: Plain) => unknown> = { wide: () => "w" };
console.log(plains["hasOwnProperty"](asPlain), plains["propertyIsEnumerable"](asPlain), calls);

// The other properties are read from the source object when observed.
wide.extra = "y";
console.log(JSON.stringify(asPlain), Object.keys(asPlain).length, asPlain.propertyIsEnumerable("extra"));

// Data properties only: util.inspect and JSON show them in the object's order.
const point3 = { z: 3, x: 1, y: 2 };
const point: Point = point3;
console.log(point, JSON.stringify(point), Object.keys(point).join(""), point.x + point.y);

// Object.values and Object.entries check kept values against their static
// result type, so this source's extra values are numbers too.
type Counts = { hits: number };
const counts3 = { hits: 1, misses: 2, retries: 3 };
const counted: Counts = counts3;
console.log(Object.values(counted).join(","), Object.entries(counted).map(([k, v]) => `${k}=${v}`).join(","));

// Values of the exact record shape keep their own answers.
const plain: Plain = { a: 2 };
console.log(String(plain), `${plain}`, plain.toString(), Object.keys(plain).join(","), JSON.stringify(plain));
console.log(plain.hasOwnProperty("a"), plain.hasOwnProperty("extra"), "extra" in plain, plain);

// Through parameters, return values, nested fields, arrays, unions and maps.
function describe(p: Plain): string {
  return `${p} ${Object.keys(p).length} ${JSON.stringify(p)}`;
}
console.log(describe(wide), describe(plain));
function relabel(source: { label: string; size: number; color: string }): Labeled {
  return source;
}
const labeled = relabel({ label: "box", size: 3, color: "red" });
console.log(labeled, Object.keys(labeled).join(","), "color" in labeled);
const holder: { at: Point; tags: string[] } = { at: point3, tags: ["t"] };
console.log(JSON.stringify(holder), Object.keys(holder.at).join(""));
const points: Point[] = [point3, { x: 5, y: 6 }];
console.log(JSON.stringify(points), points.map((p) => Object.keys(p).length).join(","));
const maybe: Point | undefined = point3;
console.log(maybe !== undefined && "z" in maybe, JSON.stringify(maybe));
const byName = new Map<string, Point>();
byName.set("p", point3);
console.log(JSON.stringify([...byName.values()]), [...byName.values()].map((p) => `${Object.keys(p)}`).join(";"));

// A copy converted into a narrower type again keeps its source's other
// properties, and through it the first object's.
type Wide2 = { a: number; b: number };
const first = { a: 1, b: 2, c: 3 };
const second: Wide2 = first;
const third: Plain = second;
console.log(Object.keys(third).join(","), JSON.stringify(third), "c" in third, third.hasOwnProperty("b"));

// Writes through an untyped view of a linked copy reach the copy, nested
// records included.
const viewed: Point = { z: 3, x: 1, y: 2 } as { z: number; x: number; y: number };
const pointView = viewed as unknown as Record<string, unknown>;
pointView.x = 10;
console.log(viewed.x, JSON.stringify(viewed), String(pointView));
type Box = { inner: Point; tag: string };
const wideBox = { inner: { x: 1, y: 2 }, tag: "t", extra: true };
const boxed: Box = wideBox;
const boxAny: unknown = boxed;
const boxView = boxAny as { inner: Record<string, unknown> };
boxView.inner.x = 7;
console.log(boxed.inner.x, JSON.stringify(boxed));

// A copy converted twice converts to a string and lists its values as the
// first object does: its own valueOf and toString run, and its other
// properties are listed after the declared ones.
type Two = { a: number; b: number };
const valued = { a: 1, b: 2, c: 3, valueOf() { return 42; } };
const valuedTwo: Two = valued;
const valuedOne: Plain = valuedTwo;
console.log("" + valuedOne, `${valuedOne}`, String(valuedOne));
type TwoNamed = { a: number; b: number; toString(): string };
const named = { a: 1, b: 2, toString() { return "named"; }, valueOf() { return 7; } };
const namedTwo: TwoNamed = named;
const namedOne: Plain = namedTwo;
console.log(String(namedOne), "" + namedOne);
const listedTwo: Two = { a: 1, b: 2, c: 3 } as { a: number; b: number; c: number };
const listedOne: Plain = listedTwo;
console.log(Object.values(listedOne), Object.entries(listedOne));
const parsedTwo: Two = JSON.parse('{"a":1,"b":2,"z":9}');
const parsedOne: Plain = parsedTwo;
console.log(Object.values(parsedOne), Object.entries(parsedOne));

// A source type whose literals write its keys in more than one order
// gives the copy its source's order.
type Ordered = { a: number; b: number; c?: number };
function ordered(flip: boolean): Ordered {
  return flip ? { b: 2, a: 1 } : { a: 1, b: 2, c: 3 };
}
const flipped: Plain = ordered(true);
const straight: Plain = ordered(false);
console.log(Object.keys(flipped).join(","), JSON.stringify(flipped), JSON.stringify(straight));

// Two types that each lack an optional field of the other convert both
// ways, and each copy lists the first object's values.
type OptB = { a: number; b?: number };
type OptC = { a: number; c?: number };
const withB: OptB = { a: 1, b: 2 };
const asC: OptC = withB;
const backToB: OptB = asC;
console.log(Object.values(backToB), Object.entries(asC), JSON.stringify(backToB));

// `+` calls the first object's valueOf even when it returns an object,
// which then falls back to toString; a throw propagates.
let valueOfCalls = 0;
const objectValued = {
  a: 1,
  b: 2,
  valueOf() {
    valueOfCalls++;
    return {};
  },
  toString() {
    return "objectValued";
  },
};
const objectValuedOne: Plain = objectValued;
console.log("" + objectValuedOne, valueOfCalls);
const throwing = {
  a: 1,
  b: 2,
  valueOf(): object {
    throw new Error("valueOf threw");
  },
};
const throwingOne: Plain = throwing;
try {
  console.log("" + throwingOne);
} catch (e) {
  console.log("caught", (e as Error).message);
}
const untyped = { a: 1, b: 2, valueOf(): unknown { return valueOfCalls > 1 ? null : 5; } };
const untypedOne: Plain = untyped;
console.log("" + untypedOne, (valueOfCalls++, "" + untypedOne));

// A copy narrowed from a width spread that kept its source's other
// properties sees them too.
type Three = { a: number; b: number; c: number };
function three(): Three {
  return { a: 1, b: 2, c: 3 };
}
const spreadTwo: Two = { ...three() };
const spreadOne: Plain = spreadTwo;
const spreadKeys: string[] = [];
for (const k in spreadOne) spreadKeys.push(k);
console.log(
  Object.keys(spreadOne).join(","),
  JSON.stringify(spreadOne),
  "c" in spreadOne,
  spreadKeys.join(","),
  Object.values(spreadOne).join(","),
);
