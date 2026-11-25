// Descriptors held in variables: the values and functions stay the same objects.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const o: any = {};
const list = [1];
const shared = { n: 1 };
const d = { value: list, enumerable: true };
const fn = function (): number { return 5; };
try {
  Object.defineProperties(o, { a: d, b: d, c: { value: shared }, m: { value: fn }, g: { get: fn } });
  list.push(2); shared.n = 5;
  console.log(o.a === list, o.b === list, o.a.length, o.c === shared, o.c.n, o.m === fn, o.m(), o.g);
  console.log(Object.getOwnPropertyDescriptor(o, "g")!.get === fn);
} catch (e) { console.log("failed:", msg(e)); }

export {};
