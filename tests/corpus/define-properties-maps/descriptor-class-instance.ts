// A class instance and an object with inherited fields as descriptors.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

class Desc { value = 7; enumerable = true; }
const o: any = {};
try {
  Object.defineProperties(o, { a: new Desc() });
  console.log(o.a, Object.keys(o).join(","));
} catch (e) { console.log("failed:", msg(e)); }
const p: any = {};
const proto: any = JSON.parse('{"value":9,"enumerable":true}');
const inherited: PropertyDescriptor = Object.create(proto);
try {
  Object.defineProperties(p, { c: inherited });
  console.log(p.c, Object.keys(p).join(","));
} catch (e) { console.log("failed:", msg(e)); }

export {};
