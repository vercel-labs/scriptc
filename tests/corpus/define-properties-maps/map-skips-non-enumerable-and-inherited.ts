// Keys the map does not enumerate, and keys it inherits, are not read.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const o: any = {};
const p: any = {};
const map: any = JSON.parse('{"a":{"value":1,"enumerable":true}}');
Object.defineProperty(map, "skipped", { value: { value: 2, enumerable: true }, enumerable: false });
const child: any = Object.create(map);
child.own = { value: 3, enumerable: true };
try {
  Object.defineProperties(o, map);
  Object.defineProperties(p, child);
  console.log(Object.keys(o).join(","), Object.keys(p).join(","));
} catch (e) { console.log("failed:", msg(e)); }

export {};
