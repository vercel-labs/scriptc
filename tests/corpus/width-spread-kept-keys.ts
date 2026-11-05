// A spread of a wider record into a narrower declared record keeps every
// own key of the source, as Node's copy does: the extra keys show up in
// Object.keys, JSON.stringify, console output, structuredClone and later
// copies. Declared fields stay plain typed slots.

type Cfg = { command: string; args?: string[]; timeout?: number };
type Patch = { timeout?: number; url?: string; command?: string };

// The merge idiom: a patch with a key the config does not declare.
function patchOne(config: Cfg, patch: Patch): Cfg {
  return { ...config, ...patch };
}
console.log(JSON.stringify(patchOne({ command: "c" }, { url: "mixed" })));
console.log(JSON.stringify(patchOne({ command: "c", timeout: 1 }, { url: "u", timeout: 2 })));
console.log(JSON.stringify(patchOne({ command: "c" }, {})));
const overridden = patchOne({ command: "c", args: ["a"] }, { command: "d", url: undefined });
console.log(JSON.stringify(overridden), Object.keys(overridden).join(","));

// An optional patch: `...undefined` copies nothing.
function patchMaybe(config: Cfg, patch: Patch | undefined): Cfg {
  return { ...config, ...patch };
}
console.log(JSON.stringify(patchMaybe({ command: "m" }, undefined)));
console.log(JSON.stringify(patchMaybe({ command: "m" }, { url: "v" })));

// A lone spread returned through a narrower declared result.
type Point = { x: number; y: number };
type Point3 = { x: number; y: number; z: number };
function flat(p: Point3): Point {
  return { ...p };
}
console.log(JSON.stringify(flat({ x: 1, y: 2, z: 3 })));

// The reflective surfaces over one copy.
type Narrow = { a: number; b?: string };
type Wide = { a: number; b?: string; extra: string; nested: { n: number } };
const wide: Wide = { a: 1, extra: "x", nested: { n: 1 }, b: "bee" };
const r: Narrow = { ...wide };
console.log(Object.keys(r).join(","));
console.log(JSON.stringify(r));
console.log(r);
console.log(JSON.stringify(structuredClone(r)));
console.log(JSON.stringify([r, { ...wide, a: 7 } as Narrow]));
const index: Record<string, unknown> = { ...r };
console.log(Object.keys(index).join(","));

// Declared reads are typed slot reads.
console.log(r.a + 1, r.b?.toUpperCase());

// Writes after the copy change only the copy; the source's other keys were
// copied by value when the spread ran, and nested objects stay shared.
const source: Wide = { a: 1, extra: "x", nested: { n: 1 } };
const copy: Narrow = { ...source, a: 2 };
copy.a = 3;
copy.b = "late";
source.extra = "changed";
source.nested.n = 99;
source.a = 100;
console.log(JSON.stringify(copy));
console.log(JSON.stringify(source));

// Key order: keys in creation order, a key keeps its first position.
const order: Narrow = { b: "first", ...source };
console.log(Object.keys(order).join(","));
const middle: Narrow = { ...source, b: "mid", ...{ a: 5, tail: true } };
console.log(JSON.stringify(middle));

// A copy of a copy: the second width spread copies the first one's keys.
type Wider = { a: number; b?: string; extra: string; nested: { n: number }; more: boolean };
const wider: Wider = { a: 1, extra: "e", nested: { n: 2 }, more: true };
const mid: Wide = { ...wider };
const last: Narrow = { ...mid };
console.log(JSON.stringify(last));

// Copies in a loop each keep their own keys.
const rows: Narrow[] = [];
for (let i = 0; i < 3; i++) {
  const w: Wide = { a: i, extra: `e${i}`, nested: { n: i } };
  rows.push({ ...w });
}
console.log(JSON.stringify(rows));
