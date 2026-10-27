// Records enumerate their keys in the order their object literals create
// them, even when every literal writes the keys in another order than the
// type declares them and the value is observed far from the literal:
// factory returns, arrays, Maps, nested records, generic factories, union
// arms, records widened to unknown/any, structuredClone, and every
// order-observing surface (keys, values, entries, for...in, JSON.stringify
// with replacers and indentation, inspect, console.log, util.format).
import { format, inspect } from "node:util";

interface Point {
  x: number;
  y: number;
  label: string;
}
function makePoint(i: number): Point {
  return { label: "p" + i, y: i * 2, x: i };
}

const p = makePoint(1);
console.log(Object.keys(p).join(","));
console.log(Object.values(p).join(","));
console.log(JSON.stringify(Object.entries(p)));
const forIn: string[] = [];
for (const k in p) forIn.push(k);
console.log(forIn.join(","));
console.log(JSON.stringify(p));
console.log(JSON.stringify(p, null, 2));
console.log(JSON.stringify(p, ["y", "x"]));
const visited: string[] = [];
JSON.stringify(p, (key: string, value: unknown) => {
  visited.push(key);
  return value;
});
console.log(visited.join(","));
console.log(p);
console.log(inspect(p));
console.log(format("%o|%j|%O", p, p, p));

// Arrays of records: literals pushed in a loop and produced by map.
interface Row {
  id: number;
  name: string;
  score: number;
}
const rows: Row[] = [];
for (let i = 0; i < 3; i++) rows.push({ name: "n" + i, score: i * 10, id: i });
for (const r of rows) console.log(Object.values(r).join("|"));
console.log(JSON.stringify(rows));
const mapped: Row[] = [4, 5].map((i) => ({ name: "m" + i, score: i, id: i * 100 }));
console.log(JSON.stringify(mapped));
console.log(mapped);

// Records stored in a Map, read back, serialized and inspected.
const byName = new Map<string, Row>();
for (const r of rows) byName.set(r.name, r);
byName.set("extra", { name: "extra", score: 9, id: 99 });
console.log(byName);
console.log(JSON.stringify([...byName.values()]));
console.log(Object.keys(byName.get("extra")!).join(","));

// Nested records: every level keeps its own literal's order.
interface Inner {
  b: number;
  a: number;
}
interface Outer {
  inner: Inner;
  id: number;
  tags: string[];
}
function makeOuter(id: number): Outer {
  return { id, tags: ["t" + id], inner: { a: id, b: id + 1 } };
}
console.log(JSON.stringify(makeOuter(1)));
console.log(makeOuter(2));
console.log(JSON.stringify([makeOuter(3), makeOuter(4)], null, 1));

// Generic factories instantiate per type argument.
function boxed<T>(value: T): { value: T; tag: string; count: number } {
  return { tag: "box", count: 1, value };
}
console.log(JSON.stringify(boxed(7)));
console.log(JSON.stringify(boxed("s")));
console.log(Object.keys(boxed(true)).join(","));

// Union arms keep their own literal orders.
type Shape = { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number };
function shapeAt(i: number): Shape {
  return i % 2 === 0 ? { r: i, kind: "circle" } : { h: i, kind: "rect", w: i + 1 };
}
const shapes: Shape[] = [shapeAt(0), shapeAt(1), shapeAt(2)];
for (const s of shapes) console.log(JSON.stringify(s));
console.log(shapes);

// Widened to unknown and any, and cloned.
const u: unknown = makePoint(3);
console.log(JSON.stringify(u));
const loose: any = makePoint(4);
console.log(Object.keys(loose).join(","));
const cloned = structuredClone(makePoint(5));
console.log(JSON.stringify(cloned), Object.keys(cloned).join(","));

// Integer-like keys still come first, ascending, ahead of the literal order.
interface Indexed {
  name: string;
  "10": number;
  "2": number;
  "01": number;
}
function makeIndexed(): Indexed {
  return { "01": 1, name: "n", "10": 10, "2": 2 };
}
console.log(JSON.stringify(makeIndexed()));
console.log(Object.keys(makeIndexed()).join(","));

// A literal whose fields are flipped by later assignments: assigning an
// existing key never moves it (the pattern of scriptc's own
// RuntimeFeatures scan).
interface Features {
  regex: boolean;
  eventTarget: boolean;
  warningReplace: boolean;
  stdioExtended: boolean;
  processEvents: boolean;
  emitter: boolean;
}
function scanFeatures(classes: string[], workers: boolean): Features {
  const features: Features = {
    regex: false,
    eventTarget: classes.some((c) => c === "EventTarget"),
    processEvents: false,
    warningReplace: false,
    stdioExtended: false,
    emitter: workers,
  };
  if (classes.length > 1) features.regex = true;
  features.stdioExtended = workers;
  return features;
}
console.log(JSON.stringify(scanFeatures(["EventTarget", "X"], true)));
console.log(JSON.stringify(scanFeatures([], false)));

// Literals written in declaration order keep it.
interface Ordered {
  first: string;
  second: number;
  third: boolean;
}
const ordered: Ordered = { first: "f", second: 2, third: true };
console.log(JSON.stringify(ordered), Object.keys(ordered).join(","));
