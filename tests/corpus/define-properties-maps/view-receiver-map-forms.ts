// A map variable and computed keys on a receiver that is an object literal of getters.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

interface Base { readonly a: number }
interface Wide extends Base { b: number; readonly c: string; d(): number }
const sym = Symbol("s");
const base: Base = { get a() { return 1; } };
const map = { b: { value: 2, enumerable: true, writable: true }, c: { get() { return "c"; } }, d: { value(this: Wide) { return this.a + this.b; } } };
try {
  const wide = Object.defineProperties(base as Wide, map);
  wide.b = 5;
  console.log(wide === base, wide.a, wide.b, wide.c, wide.d(), Object.keys(wide).join(","));
} catch (e) { console.log("failed:", msg(e)); }
const other: Base = { get a() { return 7; } };
try {
  Object.defineProperties(other, { [sym]: { value: "S" }, ["k" + other.a]: { value: "K", enumerable: true } });
  console.log(desc(other, sym), desc(other, "k7"), Object.keys(other).join(","));
} catch (e) { console.log("failed:", msg(e)); }

export {};
