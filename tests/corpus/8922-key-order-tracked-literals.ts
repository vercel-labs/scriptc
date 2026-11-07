// A record type whose literals create their keys in orders no one table
// describes: spreads before and after explicit keys, two spreads of values
// that hold different optional keys, a spread into a wider type, a leading
// conditional spread, defaults a spread overrides. Each value enumerates its
// keys in the order its literal created them, through every surface.
function keysIn(value: object): string {
  const out: string[] = [];
  for (const k in value) out.push(k);
  return out.join(",");
}

// A spread before and after an explicit key, and a clone that overrides.
interface Point { a: number; b: number }
interface Point3 { a: number; b: number; c: number }
function show3(tag: string, r: Point3): void {
  console.log(tag, Object.keys(r).join(","), keysIn(r), JSON.stringify(r), r);
  console.log(tag, Object.entries(r).map((e) => e[0]).join(","), Object.keys({ ...r }).join(","));
}
const point: Point = { a: 1, b: 2 };
const before: Point3 = { c: 0, ...point };
const after: Point3 = { ...point, c: 0 };
const over: Point3 = { ...before, a: 9 };
show3("before", before);
show3("after", after);
show3("override", over);

// Two spreads of one type: each key sits where its first spread put it.
interface Flags { a?: number; b?: number; c?: number }
function merge(p: Flags, q: Flags): Flags {
  return { ...p, ...q };
}
function showFlags(tag: string, r: Flags): void {
  console.log(tag, Object.keys(r).join(","), keysIn(r), JSON.stringify(r), r);
}
showFlags("b-a", merge({ b: 1 }, { a: 2 }));
showFlags("a-b", merge({ a: 1 }, { b: 2 }));
showFlags("c-b-a", merge({ c: 1 }, { b: 2, a: 3 }));
showFlags("c-a-b", merge({ c: 1, a: 0 }, { b: 2, a: 3 }));
console.log(JSON.stringify([merge({ c: 1 }, {}), merge({}, { b: 1, c: 2 })]));

// A spread into a wider type, of values whose own key order differs.
interface Narrow { m: number; k?: string }
interface Wide { extra: number; m: number; k?: string }
function widen(n: Narrow): Wide {
  return { ...n, extra: 1 };
}
function showWide(tag: string, r: Wide): void {
  console.log(tag, Object.keys(r).join(","), keysIn(r), JSON.stringify(r), r);
}
showWide("no-k", widen({ m: 1 }));
showWide("k-first", widen({ k: "v", m: 1 }));
const lateK: Narrow = { m: 2 };
lateK.k = "late";
showWide("k-late", widen(lateK));

// Conditional spreads, leading and in the middle.
interface Cond { a: number; b?: number; d: number; e?: string }
function middle(c: boolean, f: boolean): Cond {
  return { a: 1, ...(c ? { b: 2 } : {}), d: 3, ...(f && { e: "e" }) };
}
function lead(c: boolean): Cond {
  return { ...(c ? { e: "lead" } : {}), d: 1, a: 2 };
}
function showCond(tag: string, r: Cond): void {
  console.log(tag, Object.keys(r).join(","), keysIn(r), JSON.stringify(r), r);
}
showCond("tt", middle(true, true));
showCond("ft", middle(false, true));
showCond("lead-t", lead(true));
showCond("lead-f", lead(false));
const filled = middle(false, false);
filled.e = "late";
filled.b = 7;
showCond("filled", filled);
const led = lead(false);
led.e = "after";
showCond("led", led);

// Defaults a spread overrides: the defaults keep their places.
interface Options { host?: string; port?: number; secure?: boolean; path?: string }
function withDefaults(o: Options): Options {
  return { port: 80, host: "h", ...o };
}
const base: Options = { secure: false, path: "/p" };
function merged(o: Options): Options {
  return { ...base, ...o };
}
function showOptions(tag: string, r: Options): void {
  console.log(tag, Object.keys(r).join(","), keysIn(r), JSON.stringify(r), r);
}
showOptions("empty", withDefaults({}));
showOptions("secure-port", withDefaults({ secure: true, port: 1 }));
showOptions("path-host", withDefaults({ path: "/", host: "x" }));
showOptions("merged", merged({ host: "m", secure: true }));

// Nested values keep their own orders inside containers.
interface Inner { n: number; x?: number; y?: number }
interface Outer { name: string; inner: Inner; list: Inner[] }
function inner(flip: boolean, n: number): Inner {
  const i: Inner = flip ? { y: 1, n } : { n };
  return flip ? { x: 0, ...i } : { ...i, x: 0 };
}
const outer: Outer = { name: "o", inner: inner(true, 1), list: [inner(false, 2), inner(true, 3)] };
console.log(JSON.stringify(outer), outer);
console.log(new Map<string, Inner>([["k", inner(true, 4)]]));

// A spread value whose own type nothing enumerates, built in another order
// than its type declares: the literal takes the order the value was built in.
interface Unseen { north: number; south: number }
interface Seen { north: number; south: number; east: number }
const unseen: Unseen = { south: 2, north: 1 };
const seenBefore: Seen = { east: 0, ...unseen };
const seenAfter: Seen = { ...unseen, east: 0 };
console.log(Object.keys(seenBefore).join(","), JSON.stringify(seenBefore));
console.log(Object.keys(seenAfter).join(","), JSON.stringify(seenAfter));
