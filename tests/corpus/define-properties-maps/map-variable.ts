// A map held in a variable, and one passed as a parameter of an index-signature type.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const o: any = {};
const map = { a: { value: 1, enumerable: true }, b: { get() { return 2; }, enumerable: true } };
try {
  const same = Object.defineProperties(o, map);
  console.log(same === o, o.a, o.b, Object.keys(o).join(","), Object.keys(map).join(","), map.a.value);
} catch (e) { console.log("failed:", msg(e)); }
function define(target: object, descriptors: { [key: string]: { value: number; enumerable: boolean } }): string {
  return Object.keys(Object.defineProperties(target, descriptors)).join(",");
}
try { console.log(define({}, { x: { value: 1, enumerable: true }, y: { value: 2, enumerable: false } })); } catch (e) { console.log("failed:", msg(e)); }

export {};
